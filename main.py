import bcrypt
import base64
import json
import logging
import os
import shutil
import sqlite3
import subprocess
import tempfile
import time
import threading
from functools import wraps
import mimetypes # For getProjectImageHandler

from flask import Flask, request, jsonify, session, g, send_from_directory, abort

# --- Constants ---
DB_FILE_NAME = "db/underlog.db"
# Flask uses app.secret_key for signing sessions.
# This SECRET_KEY should be overridden by an environment variable or config file in production.
SECRET_KEY = os.environ.get("SESSION_SECRET", "replace-this-with-a-real-secret-key")
STATIC_DIR = "./static"
USER_ID_CONTEXT_KEY = "user_id" # Key for flask.g and session
DEFAULT_PROJECT_NAME = "Untitled Project"
PDF_TEMP_DIR_PREFIX = "underlog-pdf-"

# --- Globals ---
db: sqlite3.Connection = None # sqlite3.Connection object, type hinted
db_lock = threading.Lock() # To protect DB operations

# --- Configure Logging ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
log = logging.getLogger(__name__)

# --- Database Initialization ---
def init_db(filename: str) -> sqlite3.Connection:
    log.info(f"Initializing database: {filename}")

    db_dir = os.path.dirname(filename)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    database = sqlite3.connect(filename, check_same_thread=False)
    database.execute("PRAGMA foreign_keys = ON")

    schema = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    body TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, name)
);

CREATE TRIGGER IF NOT EXISTS update_projects_updated_at
AFTER UPDATE ON projects
FOR EACH ROW
BEGIN
    UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    blob BLOB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE(project_id, name)
);
    """
    try:
        database.executescript(schema)
        database.commit()
        log.info("Database initialized successfully.")
    except sqlite3.Error as e:
        database.close()
        log.error(f"Database schema execution failed: {e}")
        raise
    return database

# --- Password Hashing ---
def hash_password(password: str) -> str:
    salt = bcrypt.gensalt()
    hashed_bytes = bcrypt.hashpw(password.encode('utf-8'), salt)
    return hashed_bytes.decode('utf-8')

def check_password_hash(password: str, hash_str: str) -> bool:
    return bcrypt.checkpw(password.encode('utf-8'), hash_str.encode('utf-8'))

# --- Flask App Initialization ---
app = Flask(__name__, static_folder=STATIC_DIR, static_url_path='/')
app.secret_key = SECRET_KEY
if SECRET_KEY == "replace-this-with-a-real-secret-key":
    log.warning("WARNING: Using default insecure session secret key!")

# --- Middleware (Decorator for Auth) ---
def auth_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if USER_ID_CONTEXT_KEY not in session:
            log.warning(f"Auth required: Unauthorized access attempt to {request.path}")
            abort(401, description="Unauthorized. Please log in.")

        user_id = session.get(USER_ID_CONTEXT_KEY)
        if not isinstance(user_id, int):
            log.error(f"Auth required: Invalid user_id type in session for {request.path}")
            session.pop(USER_ID_CONTEXT_KEY, None) # Clear corrupted session data
            abort(401, description="Unauthorized due to invalid session. Please log in again.")

        g.user_id = user_id
        log.info(f"Auth middleware: User {g.user_id} authorized for {request.path}")
        return f(*args, **kwargs)
    return decorated_function

# --- Handlers ---

@app.route("/register", methods=["POST"])
def register_handler():
    try:
        data = request.get_json()
        username = data.get("username")
        password = data.get("password")
    except Exception:
        return jsonify({"error": "Invalid request body"}), 400

    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400

    try:
        hashed_password = hash_password(password)
    except Exception as e:
        log.error(f"Error hashing password for {username}: {e}")
        return jsonify({"error": "Failed to process registration"}), 500

    with db_lock:
        try:
            cursor = db.cursor()
            cursor.execute("INSERT INTO users (username, password_hash) VALUES (?, ?)", (username, hashed_password))
            db.commit()
        except sqlite3.IntegrityError:
            log.warning(f"Registration attempt for existing username: {username}")
            return jsonify({"error": "Username may already be taken"}), 409
        except sqlite3.Error as e:
            log.error(f"Error inserting user {username}: {e}")
            db.rollback()
            return jsonify({"error": "Failed to register user"}), 500

    log.info(f"User registered successfully: {username}")
    return jsonify({"message": "User registered successfully"}), 201

@app.route("/login", methods=["POST"])
def login_handler():
    try:
        data = request.get_json()
        username = data.get("username")
        password = data.get("password")
    except Exception:
        return jsonify({"error": "Invalid request body"}), 400

    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400

    user_id = None
    stored_hash = None
    with db_lock:
        try:
            cursor = db.cursor()
            cursor.execute("SELECT id, password_hash FROM users WHERE username = ?", (username,))
            row = cursor.fetchone() # Returns (id, password_hash) or None
            if row:
                user_id, stored_hash = row[0], row[1]
        except sqlite3.Error as e:
            log.error(f"Error querying user {username}: {e}")
            return jsonify({"error": "Login failed due to database error"}), 500

    if not user_id or not stored_hash:
        log.warning(f"Login attempt failed for {username}: user not found")
        return jsonify({"error": "Invalid username or password"}), 401

    if not check_password_hash(password, stored_hash):
        log.warning(f"Login attempt failed for {username}: incorrect password")
        return jsonify({"error": "Invalid username or password"}), 401

    session[USER_ID_CONTEXT_KEY] = user_id
    session.permanent = True
    app.permanent_session_lifetime = 86400 # 1 day

    log.info(f"User logged in successfully: {username} (ID: {user_id})")
    return jsonify({"message": "Login successful"}), 200

@app.route("/logout", methods=["POST"])
def logout_handler():
    user_id_logged_out = session.pop(USER_ID_CONTEXT_KEY, None)
    if user_id_logged_out:
        log.info(f"User {user_id_logged_out} logged out")
    else:
        log.info("Logout attempt for non-logged-in session or session without user_id")
    return jsonify({"message": "Logout successful"}), 200

@app.route("/pdf", methods=["POST"])
def pdf_handler():
    try:
        pdf_req = request.get_json()
        if not pdf_req or "input" not in pdf_req:
            return jsonify({"error": "Invalid JSON payload, 'input' field required"}), 400
        svg_input = pdf_req["input"]
        if not svg_input:
            return jsonify({"error": "SVG input is required"}), 400
    except Exception as e:
        log.error(f"Error decoding PDF request JSON: {e}. Body: {request.data}")
        return jsonify({"error": "Invalid JSON payload: " + str(e)}), 400

    log.info("Received PDF generation request, creating temp directory...")
    temp_dir = None
    try:
        temp_dir = tempfile.mkdtemp(prefix=PDF_TEMP_DIR_PREFIX)
        log.info(f"Temporary directory created: {temp_dir}")

        svg_file_path = os.path.join(temp_dir, "underlog.svg")
        with open(svg_file_path, "w", encoding='utf-8') as f:
            f.write(svg_input)
        log.info(f"SVG content written to {svg_file_path}")

        awk_cmd = 'awk \'/<svg/{n++} n{print > "input_" n ".svg"}\' underlog.svg'
        log.info(f"Executing awk command in {temp_dir}: {awk_cmd}")
        proc1 = subprocess.run(['bash', '-c', awk_cmd], cwd=temp_dir, capture_output=True, text=True, check=False)
        if proc1.returncode != 0:
            log.error(f"Error executing awk command (ret {proc1.returncode}): {proc1.stderr}\nOutput: {proc1.stdout}")
            return jsonify({"error": "Failed to process SVG (split step)"}), 500
        log.info(f"awk command successful. Output:\n{proc1.stdout[:200]}\nStderr:\n{proc1.stderr[:200]}")

        svg2pdf_cmd = 'for file in input_*.svg; do svg2pdf "$file" "${file%.svg}.pdf"; done'
        log.info(f"Executing svg2pdf loop in {temp_dir}: {svg2pdf_cmd}")
        proc2 = subprocess.run(['bash', '-c', svg2pdf_cmd], cwd=temp_dir, capture_output=True, text=True, check=False)
        if proc2.returncode != 0:
            log.error(f"Error executing svg2pdf loop (ret {proc2.returncode}): {proc2.stderr}\nOutput: {proc2.stdout}")
            return jsonify({"error": "Failed to process SVG (conversion step)"}), 500
        log.info(f"svg2pdf loop successful. Output:\n{proc2.stdout[:200]}\nStderr:\n{proc2.stderr[:200]}")

        gs_cmd = "gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.5 -dPDFSETTINGS=/default -dNOPAUSE -dQUIET -dBATCH " \
            "-dDetectDuplicateImages -dCompressFonts=true -r150 -sOutputFile=underlog.pdf " \
            "$(ls -v input_*.pdf | tr '\\n' ' ')" # ls -v for natural sort of version numbers, common on Linux
        log.info(f"Executing gs command in {temp_dir}: {gs_cmd}")
        proc3 = subprocess.run(['bash', '-c', gs_cmd], cwd=temp_dir, capture_output=True, text=True, check=False)
        if proc3.returncode != 0:
            log.error(f"Error executing gs command (ret {proc3.returncode}): {proc3.stderr}\nOutput: {proc3.stdout}")
            return jsonify({"error": "Failed to process SVG (combine step)"}), 500
        log.info(f"gs command successful. Output:\n{proc3.stdout[:200]}\nStderr:\n{proc3.stderr[:200]}")

        pdf_file_path = os.path.join(temp_dir, "underlog.pdf")
        if not os.path.exists(pdf_file_path) or os.path.getsize(pdf_file_path) == 0:
            log.error(f"Generated PDF file not found or empty at {pdf_file_path}. GS output: stdout='{proc3.stdout}', stderr='{proc3.stderr}'")
            return jsonify({"error": "Failed to find or generate a valid PDF"}), 500

        with open(pdf_file_path, "rb") as f:
            pdf_bytes = f.read()
        log.info(f"Successfully generated and read {pdf_file_path} ({len(pdf_bytes)} bytes)")

        response = app.response_class(response=pdf_bytes, status=200, mimetype='application/pdf')
        response.headers['Content-Disposition'] = 'attachment; filename="underlog.pdf"'
        return response

    except FileNotFoundError as e:
        log.error(f"A required command (svg2pdf, gs, awk, bash) was not found: {e}")
        return jsonify({"error": f"Server configuration error: command not found ({e.filename})"}), 500
    except Exception as e:
        log.error(f"Unexpected error in pdfHandler: {e}", exc_info=True)
        return jsonify({"error": "Failed to process request (internal server error)"}), 500
    finally:
        if temp_dir and os.path.exists(temp_dir):
            log.info(f"Cleaning up temporary directory: {temp_dir}")
            try:
                shutil.rmtree(temp_dir)
            except Exception as e_rm:
                log.error(f"Error cleaning up temporary directory {temp_dir}: {e_rm}")

@app.route("/odt", methods=["POST"])
def odt_handler():
    log.info("ODT endpoint called (not implemented)")
    return jsonify({"error": "ODT generation not implemented"}), 501

@app.route("/api/projects", methods=["GET"])
@auth_required
def get_projects_handler():
    user_id = g.user_id
    projects = []
    with db_lock:
        try:
            cursor = db.cursor()
            cursor.row_factory = sqlite3.Row # Makes rows dict-accessible
            cursor.execute("SELECT id, name FROM projects WHERE user_id = ? ORDER BY updated_at DESC", (user_id,))
            rows = cursor.fetchall()
            cursor.row_factory = None # Reset
            for row in rows:
                projects.append({"id": row["id"], "name": row["name"]})
        except sqlite3.Error as e:
            log.error(f"Error querying projects for user {user_id}: {e}")
            return jsonify({"error": "Failed to retrieve projects"}), 500
    return jsonify(projects), 200

@app.route("/api/projects", methods=["POST"])
@auth_required
def create_project_handler():
    user_id = g.user_id
    try:
        data = request.get_json()
        project_name_req = data.get("name", "")
        project_body = data.get("body", "")
    except Exception:
        return jsonify({"error": "Invalid request body"}), 400

    project_name = project_name_req if project_name_req else DEFAULT_PROJECT_NAME

    project_id = None
    with db_lock:
        try:
            cursor = db.cursor()
            cursor.execute("SELECT id FROM projects WHERE user_id = ? AND name = ?", (user_id, project_name))
            if cursor.fetchone():
                return jsonify({"error": "Project name already exists"}), 409

            # Relies on DB DEFAULT for created_at, explicitly sets updated_at
            current_time_for_db = time.strftime('%Y-%m-%d %H:%M:%S')
            cursor.execute(
                "INSERT INTO projects (user_id, name, body, updated_at) VALUES (?, ?, ?, ?)",
                (user_id, project_name, project_body, current_time_for_db)
            )
            project_id = cursor.lastrowid
            db.commit()
        except sqlite3.Error as e:
            db.rollback()
            log.error(f"Error creating project '{project_name}' for user {user_id}: {e}")
            return jsonify({"error": "Failed to create project"}), 500

    if project_id is None:
        log.error(f"Project created for user {user_id} but failed to get ID for '{project_name}'")
        return jsonify({"error": "Project created but failed to retrieve ID"}), 500

    log.info(f"Created project ID {project_id} ('{project_name}') for user {user_id}")
    return jsonify({
        "message": "Project created successfully",
        "projectId": project_id,
        "name": project_name,
    }), 201

@app.route("/api/projects/<int:project_id_param>", methods=["GET"])
@auth_required
def get_project_handler(project_id_param: int):
    user_id = g.user_id
    project_id = project_id_param

    log.info(f"Fetching project {project_id} for user {user_id}")
    project_detail = {}

    with db_lock:
        try:
            cursor = db.cursor()
            cursor.row_factory = sqlite3.Row

            cursor.execute("SELECT name, body FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id))
            project_row = cursor.fetchone()
            if not project_row:
                log.warning(f"Project {project_id} not found or does not belong to user {user_id}")
                return jsonify({"error": "Project not found"}), 404

            project_detail = {
                "id": project_id,
                "name": project_row["name"],
                "body": project_row["body"] if project_row["body"] is not None else ""
            }

            cursor.execute("SELECT name FROM images WHERE project_id = ?", (project_id,))
            image_rows = cursor.fetchall()
            project_detail["image_names"] = [row["name"] for row in image_rows]

            cursor.row_factory = None
        except sqlite3.Error as e:
            log.error(f"Error fetching project {project_id} details for user {user_id}: {e}")
            return jsonify({"error": "Failed to retrieve project"}), 500

    return jsonify(project_detail), 200

@app.route("/api/projects/<int:project_id_param>/image/<path:image_name>", methods=["GET"])
@auth_required
def get_project_image_handler(project_id_param: int, image_name: str):
    user_id = g.user_id
    project_id = project_id_param

    log.info(f"Fetching image '{image_name}' for project {project_id}, user {user_id}")

    image_blob = None
    with db_lock:
        try:
            cursor = db.cursor()
            cursor.execute("SELECT user_id FROM projects WHERE id = ?", (project_id,))
            project_owner_row = cursor.fetchone()
            if not project_owner_row:
                return jsonify({"error": "Project not found"}), 404
            if project_owner_row[0] != user_id:
                log.warning(f"User {user_id} attempted to access image '{image_name}' from project {project_id} owned by user {project_owner_row[0]}")
                return jsonify({"error": "Forbidden"}), 403

            cursor.execute("SELECT blob FROM images WHERE project_id = ? AND name = ?", (project_id, image_name))
            blob_row = cursor.fetchone()
            if not blob_row:
                log.warning(f"Image '{image_name}' not found for project {project_id}")
                return jsonify({"error": "Image not found"}), 404
            image_blob = blob_row[0]
        except sqlite3.Error as e:
            log.error(f"Error fetching image blob '{image_name}' for project {project_id}: {e}")
            return jsonify({"error": "Failed to retrieve image"}), 500

    content_type, _ = mimetypes.guess_type(image_name)
    if content_type is None:
        content_type = "application/octet-stream"

    response = app.response_class(response=image_blob, status=200, mimetype=content_type)
    response.headers['Content-Length'] = str(len(image_blob))
    return response

@app.route("/api/projects/<int:project_id_param>", methods=["PUT"])
@auth_required
def update_project_handler(project_id_param: int):
    user_id = g.user_id
    project_id = project_id_param

    try:
        req_data = request.get_json()
        if not req_data: return jsonify({"error": "Invalid request body"}), 400
        project_name_req = req_data.get("name", "") # If "name" key missing, default to empty string
        project_body = req_data.get("body", "")
        images_data = req_data.get("images", [])
    except Exception:
        return jsonify({"error": "Malformed request body"}), 400

    log.info(f"Updating project {project_id} (requested name: '{project_name_req}') for user {user_id}")
    project_name = project_name_req if project_name_req else DEFAULT_PROJECT_NAME

    with db_lock:
        try:
            cursor = db.cursor()

            # Check for name collision if name is changing
            if project_name_req: # Only if name is part of the request
                cursor.execute("SELECT id FROM projects WHERE user_id = ? AND name = ? AND id != ?",
                               (user_id, project_name, project_id))
                if cursor.fetchone():
                    return jsonify({"error": f"Another project with name '{project_name}' already exists."}), 409

            current_time_for_db = time.strftime('%Y-%m-%d %H:%M:%S')
            cursor.execute( # Trigger will update updated_at, but Go code sets it explicitly. We match that.
                           "UPDATE projects SET name = ?, body = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                           (project_name, project_body, current_time_for_db, project_id, user_id)
                           )
            if cursor.rowcount == 0:
                db.rollback()
                log.warning(f"Project {project_id} not found or does not belong to user {user_id} during update")
                return jsonify({"error": "Project not found or access denied"}), 404

            cursor.execute("SELECT name FROM images WHERE project_id = ?", (project_id,))
            existing_db_images = {row[0] for row in cursor.fetchall()}
            requested_images_map = {img.get("name"): img for img in images_data if img.get("name")}

            images_to_delete = existing_db_images - set(requested_images_map.keys())
            for img_name_del in images_to_delete:
                log.info(f"Deleting image '{img_name_del}' from project {project_id}")
                cursor.execute("DELETE FROM images WHERE project_id = ? AND name = ?", (project_id, img_name_del))

            for img_name, img_payload in requested_images_map.items():
                base64_blob = img_payload.get("blob_base64")
                if base64_blob:
                    try:
                        blob_bytes = base64.b64decode(base64_blob)
                    except Exception as decode_err:
                        db.rollback()
                        log.error(f"Error decoding base64 for image '{img_name}' in project {project_id}: {decode_err}")
                        return jsonify({"error": f"Invalid image data (base64) for {img_name}"}), 400

                    log.info(f"Upserting image '{img_name}' in project {project_id}")
                    # INSERT OR REPLACE will use DB DEFAULT for created_at if column not listed
                    # To match Go's behavior (where new created_at is set on REPLACE implicitly by DB default)
                    # we can omit created_at or set it. Go doesn't set it in its INSERT OR REPLACE.
                    # So, let DB handle created_at for images.
                    cursor.execute(
                        "INSERT OR REPLACE INTO images (project_id, name, blob) VALUES (?, ?, ?)",
                        (project_id, img_name, blob_bytes)
                    )
                elif img_name not in existing_db_images:
                    log.warning(f"Image '{img_name}' (project {project_id}) requested without blob and doesn't exist, skipping.")

            db.commit()
            log.info(f"Successfully updated project {project_id}")
            return jsonify({"message": "Project updated successfully"}), 200

        except sqlite3.Error as e_sql: # Catches IntegrityError too
            db.rollback()
            log.error(f"SQL error updating project {project_id}: {e_sql}")
            return jsonify({"error": f"Failed to update project (database error: {e_sql})"}), 500
        except Exception as e_gen:
            db.rollback()
            log.error(f"Generic error updating project {project_id}: {e_gen}", exc_info=True)
            return jsonify({"error": "Failed to update project (internal error)"}), 500

# --- Static File Serving ---
@app.route('/')
def root_serve_index():
    # Flask with static_url_path='/' would serve static/index.html by default for '/'.
    # This explicit route ensures our specific index.html is served, matching Go's explicit handler.
    return send_from_directory(app.static_folder, 'index.html')

# Other static files (e.g. /css/style.css) are served automatically by Flask
# from the 'static' folder due to `static_url_path='/'` in app constructor.

# --- Main Execution ---
if __name__ == "__main__":
    try:
        db = init_db(DB_FILE_NAME)
    except Exception as e:
        log.critical(f"FATAL: Failed to initialize database: {e}", exc_info=True)
        import sys
        sys.exit(f"Failed to initialize database: {e}")

    import atexit
    def close_db_connection():
        if db:
            log.info("Closing database connection.")
            db.close()
    atexit.register(close_db_connection)

    port_str = os.environ.get("FLASK_RUN_PORT", os.environ.get("PORT", "6969"))
    try:
        port = int(port_str)
    except ValueError:
        log.warning(f"Invalid PORT='{port_str}', defaulting to 6969.")
        port = 6969

    debug_mode = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    log.info(f"Server starting on http://127.0.0.1:{port} (Debug: {debug_mode})")
    app.run(host="127.0.0.1", port=port, debug=debug_mode, threaded=True)
