package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/sessions"
	_ "github.com/mattn/go-sqlite3" // SQLite driver
	"golang.org/x/crypto/bcrypt"
)

const (
	dbFileName         = "db/underlog.db"
	sessionKeyName     = "underlog-session"
	sessionSecret      = "replace-this-with-a-real-secret-key" // TODO: Use env var or config file
	staticDir          = "./static"
	userIDContextKey   = "userID" // Key for storing user ID in request context
	defaultProjectName = "Untitled Project"
	pdfTempDirPrefix   = "underlog-pdf-"
)

var (
	db           *sql.DB
	sessionStore *sessions.CookieStore
	dbMutex      sync.Mutex // To protect DB operations if needed, though database/sql handles pooling
)

// --- Structs for JSON API ---

type RegisterRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type ProjectListItem struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type ProjectDetail struct {
	ID         int64    `json:"id"`
	Name       string   `json:"name"`
	Body       string   `json:"body"`
	ImageNames []string `json:"image_names"`
}

type CreateProjectRequest struct {
	Name string `json:"name"`
	Body string `json:"body"`
}

type UpdateProjectRequest struct {
	Name   string               `json:"name"`
	Body   string               `json:"body"`
	Images []ProjectUpdateImage `json:"images"` // Client sends all images for the project
}

type ProjectUpdateImage struct {
	Name       string `json:"name"`
	BlobBase64 string `json:"blob_base64,omitempty"` // Base64 encoded blob for new/updated images
}

// PDFRequest struct for decoding the incoming JSON for PDF generation
type PDFRequest struct {
	Input string `json:"input"` // Expects SVG content here
}

// --- Database Initialization ---

func initDB(filename string) (*sql.DB, error) {
	log.Printf("Initializing database: %s", filename)
	database, err := sql.Open("sqlite3", filename+"?_foreign_keys=on") // Enable foreign key constraints
	if err != nil {
		return nil, err
	}

	// Create tables if they don't exist
	schema := `
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
	`

	_, err = database.Exec(schema)
	if err != nil {
		database.Close()
		return nil, err
	}

	log.Println("Database initialized successfully.")
	return database, nil
}

// --- Password Hashing ---

func hashPassword(password string) (string, error) {
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(bytes), err
}

func checkPasswordHash(password, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

// --- Middleware ---

func authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session, err := sessionStore.Get(r, sessionKeyName)
		if err != nil {
			log.Printf("Auth middleware: Error getting session: %v", err)
			http.Error(w, "Session error", http.StatusInternalServerError)
			return
		}

		userID, ok := session.Values[userIDContextKey].(int64)
		if !ok || userID == 0 {
			log.Printf("Auth middleware: Unauthorized access attempt to %s", r.URL.Path)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		// Add user ID to context for handlers to use
		ctx := context.WithValue(r.Context(), userIDContextKey, userID)
		log.Printf("Auth middleware: User %d authorized for %s", userID, r.URL.Path)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// --- Handlers ---

// POST /register
func registerHandler(w http.ResponseWriter, r *http.Request) {
	var req RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	if req.Username == "" || req.Password == "" {
		http.Error(w, "Username and password are required", http.StatusBadRequest)
		return
	}

	hashedPassword, err := hashPassword(req.Password)
	if err != nil {
		log.Printf("Error hashing password for %s: %v", req.Username, err)
		http.Error(w, "Failed to process registration", http.StatusInternalServerError)
		return
	}

	dbMutex.Lock()
	defer dbMutex.Unlock()
	_, err = db.Exec("INSERT INTO users (username, password_hash) VALUES (?, ?)", req.Username, hashedPassword)
	if err != nil {
		// Consider checking for unique constraint violation specifically
		log.Printf("Error inserting user %s: %v", req.Username, err)
		http.Error(w, "Username may already be taken", http.StatusConflict) // 409 Conflict
		return
	}

	log.Printf("User registered successfully: %s", req.Username)
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"message": "User registered successfully"})
}

// POST /login
func loginHandler(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var userID int64
	var storedHash string

	dbMutex.Lock()
	err := db.QueryRow("SELECT id, password_hash FROM users WHERE username = ?", req.Username).Scan(&userID, &storedHash)
	dbMutex.Unlock()

	if err != nil {
		if err == sql.ErrNoRows {
			log.Printf("Login attempt failed for %s: user not found", req.Username)
			http.Error(w, "Invalid username or password", http.StatusUnauthorized)
		} else {
			log.Printf("Error querying user %s: %v", req.Username, err)
			http.Error(w, "Login failed", http.StatusInternalServerError)
		}
		return
	}

	if !checkPasswordHash(req.Password, storedHash) {
		log.Printf("Login attempt failed for %s: incorrect password", req.Username)
		http.Error(w, "Invalid username or password", http.StatusUnauthorized)
		return
	}

	session, _ := sessionStore.Get(r, sessionKeyName)
	session.Values[userIDContextKey] = userID
	session.Options.HttpOnly = true // Prevent client-side script access
	// session.Options.Secure = true // Enable this if using HTTPS
	session.Options.MaxAge = 86400 // 1 day expiry
	err = session.Save(r, w)
	if err != nil {
		log.Printf("Error saving session for user %d: %v", userID, err)
		http.Error(w, "Failed to create session", http.StatusInternalServerError)
		return
	}

	log.Printf("User logged in successfully: %s (ID: %d)", req.Username, userID)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"message": "Login successful"})
}

// POST /logout
func logoutHandler(w http.ResponseWriter, r *http.Request) {
	session, _ := sessionStore.Get(r, sessionKeyName)
	// Clear session data
	session.Values[userIDContextKey] = nil
	session.Options.MaxAge = -1 // Expire cookie immediately
	err := session.Save(r, w)
	if err != nil {
		log.Printf("Error saving session during logout: %v", err)
		http.Error(w, "Logout failed", http.StatusInternalServerError)
		return
	}
	log.Println("User logged out")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"message": "Logout successful"})
}

// POST /pdf (Public) - Rewritten PDF Handler
func pdfHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is allowed", http.StatusMethodNotAllowed)
		return
	}

	// 1. Read and decode the JSON request body
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		log.Printf("Error reading PDF request body: %v", err)
		http.Error(w, "Failed to read request body", http.StatusInternalServerError)
		return
	}
	defer r.Body.Close()

	var pdfReq PDFRequest
	if err := json.Unmarshal(bodyBytes, &pdfReq); err != nil {
		log.Printf("Error decoding PDF request JSON: %v. Body: %s", err, string(bodyBytes))
		http.Error(w, "Invalid JSON payload: "+err.Error(), http.StatusBadRequest)
		return
	}

	if pdfReq.Input == "" {
		log.Println("PDF request received with empty SVG input")
		http.Error(w, "SVG input is required", http.StatusBadRequest)
		return
	}

	log.Println("Received PDF generation request, creating temp directory...")

	// 2. Create a temporary directory
	tempDir, err := os.MkdirTemp("", pdfTempDirPrefix)
	if err != nil {
		log.Printf("Failed to create temporary directory: %v", err)
		http.Error(w, "Failed to process request (temp dir)", http.StatusInternalServerError)
		return
	}
	log.Printf("Temporary directory created: %s", tempDir)
	defer func() {
		log.Printf("Cleaning up temporary directory: %s", tempDir)
		if err := os.RemoveAll(tempDir); err != nil {
			log.Printf("Error cleaning up temporary directory %s: %v", tempDir, err)
		}
	}()

	// 3. Write the SVG input to a file in the temp directory
	svgFilePath := filepath.Join(tempDir, "underlog.svg")
	if err := os.WriteFile(svgFilePath, []byte(pdfReq.Input), 0644); err != nil {
		log.Printf("Failed to write SVG to temporary file %s: %v", svgFilePath, err)
		http.Error(w, "Failed to process request (write SVG)", http.StatusInternalServerError)
		return
	}
	log.Printf("SVG content written to %s", svgFilePath)

	// 4. Execute the bash scripts sequentially

	// Script 1: awk to split SVG
	awkCmd := `awk '/<svg/{n++} n{print > "input_" n ".svg"}' underlog.svg`
	log.Printf("Executing awk command in %s: %s", tempDir, awkCmd)
	cmd1 := exec.Command("bash", "-c", awkCmd)
	cmd1.Dir = tempDir
	output1, err := cmd1.CombinedOutput()
	if err != nil {
		log.Printf("Error executing awk command: %v\nOutput: %s", err, string(output1))
		http.Error(w, "Failed to process SVG (split step)", http.StatusInternalServerError)
		return
	}
	log.Printf("awk command successful.\n")

	// Script 2: svg2pdf loop
	svg2pdfCmd := `for file in input_*.svg; do svg2pdf "$file" "${file%.svg}.pdf"; done`
	log.Printf("Executing svg2pdf loop in %s: %s", tempDir, svg2pdfCmd)
	cmd2 := exec.Command("bash", "-c", svg2pdfCmd)
	cmd2.Dir = tempDir
	output2, err := cmd2.CombinedOutput()
	if err != nil {
		log.Printf("Error executing svg2pdf loop: %v\nOutput: %s", err, string(output2))
		http.Error(w, "Failed to process SVG (conversion step)", http.StatusInternalServerError)
		return
	}
	log.Printf("svg2pdf loop successful.\n")

	// Script 3: gs to combine PDFs
	gsCmd := `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.5 -dPDFSETTINGS=/default -dNOPAUSE -dQUIET -dBATCH -dDetectDuplicateImages -dCompressFonts=true -r150 -sOutputFile=underlog.pdf $(printf '%s\n' input_*.pdf | sort -V | tr '\n' ' ')`
	log.Printf("Executing gs command in %s: %s", tempDir, gsCmd)
	cmd3 := exec.Command("bash", "-c", gsCmd)
	cmd3.Dir = tempDir
	output3, err := cmd3.CombinedOutput()
	if err != nil {
		log.Printf("Error executing gs command: %v\nOutput: %s", err, string(output3))
		http.Error(w, "Failed to process SVG (combine step)", http.StatusInternalServerError)
		return
	}
	log.Printf("gs command successful.\n")

	// 5. Read the resulting underlog.pdf
	pdfFilePath := filepath.Join(tempDir, "underlog.pdf")
	pdfBytes, err := os.ReadFile(pdfFilePath)
	if err != nil {
		log.Printf("Failed to read generated PDF file %s: %v", pdfFilePath, err)
		http.Error(w, "Failed to retrieve generated PDF", http.StatusInternalServerError)
		return
	}
	log.Printf("Successfully generated and read %s (%d bytes)", pdfFilePath, len(pdfBytes))

	// 6. Send the PDF to the client
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", "underlog.pdf"))
	w.Header().Set("Content-Length", strconv.Itoa(len(pdfBytes)))
	w.WriteHeader(http.StatusOK) // Or http.StatusCreated if you prefer
	_, err = w.Write(pdfBytes)
	if err != nil {
		log.Printf("Error writing PDF response to client: %v", err)
		// Client connection might have closed, not much to do here
	}
}

// POST /odt (Public)
func odtHandler(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement actual ODT generation logic
	log.Println("ODT endpoint called (not implemented)")
	http.Error(w, "ODT generation not implemented", http.StatusNotImplemented)
}

// GET /api/projects (Authenticated)
func getProjectsHandler(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(userIDContextKey).(int64)

	dbMutex.Lock()
	rows, err := db.Query("SELECT id, name FROM projects WHERE user_id = ? ORDER BY updated_at DESC", userID)
	dbMutex.Unlock()

	if err != nil {
		log.Printf("Error querying projects for user %d: %v", userID, err)
		http.Error(w, "Failed to retrieve projects", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	projects := []ProjectListItem{}
	for rows.Next() {
		var p ProjectListItem
		if err := rows.Scan(&p.ID, &p.Name); err != nil {
			log.Printf("Error scanning project row for user %d: %v", userID, err)
			http.Error(w, "Failed to process projects", http.StatusInternalServerError)
			return
		}
		projects = append(projects, p)
	}

	if err = rows.Err(); err != nil {
		log.Printf("Error iterating project rows for user %d: %v", userID, err)
		http.Error(w, "Failed to retrieve projects", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(projects)
}

// POST /api/projects (Authenticated)
func createProjectHandler(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(userIDContextKey).(int64)

	var req CreateProjectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	projectName := req.Name
	if projectName == "" {
		projectName = defaultProjectName // Or require a name from the client
	}

	dbMutex.Lock()
	defer dbMutex.Unlock()

	// Check if project name already exists for this user
	var existingID int64
	err := db.QueryRow("SELECT id FROM projects WHERE user_id = ? AND name = ?", userID, projectName).Scan(&existingID)
	if err == nil {
		http.Error(w, "Project name already exists", http.StatusConflict)
		return
	}
	if err != sql.ErrNoRows {
		log.Printf("Error checking for existing project '%s' for user %d: %v", projectName, userID, err)
		http.Error(w, "Failed to create project", http.StatusInternalServerError)
		return
	}

	result, err := db.Exec(
		"INSERT INTO projects (user_id, name, body, updated_at) VALUES (?, ?, ?, ?)",
		userID, projectName, req.Body, time.Now(),
	)
	if err != nil {
		log.Printf("Error inserting new project '%s' for user %d: %v", projectName, userID, err)
		http.Error(w, "Failed to create project", http.StatusInternalServerError)
		return
	}

	projectID, err := result.LastInsertId()
	if err != nil {
		log.Printf("Error getting last insert ID for project '%s', user %d: %v", projectName, userID, err)
		// Project was created, but we can't return the ID easily. Log and maybe return 201 without ID.
		http.Error(w, "Project created but failed to retrieve ID", http.StatusInternalServerError)
		return
	}

	log.Printf("Created project ID %d ('%s') for user %d", projectID, projectName, userID)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"message":   "Project created successfully",
		"projectId": projectID,
		"name":      projectName,
	})
}

// GET /api/projects/{id} (Authenticated)
func getProjectHandler(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(userIDContextKey).(int64)
	vars := mux.Vars(r)
	projectIDStr := vars["id"]
	projectID, err := strconv.ParseInt(projectIDStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid project ID", http.StatusBadRequest)
		return
	}

	log.Printf("Fetching project %d for user %d", projectID, userID)

	var project ProjectDetail
	project.ID = projectID

	dbMutex.Lock()
	defer dbMutex.Unlock()

	// Fetch project name and body
	err = db.QueryRow("SELECT name, body FROM projects WHERE id = ? AND user_id = ?", projectID, userID).Scan(&project.Name, &project.Body)
	if err != nil {
		if err == sql.ErrNoRows {
			log.Printf("Project %d not found or does not belong to user %d", projectID, userID)
			http.Error(w, "Project not found", http.StatusNotFound)
		} else {
			log.Printf("Error fetching project %d details for user %d: %v", projectID, userID, err)
			http.Error(w, "Failed to retrieve project", http.StatusInternalServerError)
		}
		return
	}

	// Fetch image names for the project
	rows, err := db.Query("SELECT name FROM images WHERE project_id = ?", projectID)
	if err != nil {
		log.Printf("Error fetching image names for project %d: %v", projectID, err)
		http.Error(w, "Failed to retrieve project images", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	imageNames := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			log.Printf("Error scanning image name for project %d: %v", projectID, err)
			// Continue trying to fetch other names
		} else {
			imageNames = append(imageNames, name)
		}
	}
	project.ImageNames = imageNames

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(project)
}

// GET /api/projects/{id}/image/{image_name} (Authenticated)
func getProjectImageHandler(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(userIDContextKey).(int64)
	vars := mux.Vars(r)
	projectIDStr := vars["id"]
	imageName := vars["image_name"]

	projectID, err := strconv.ParseInt(projectIDStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid project ID", http.StatusBadRequest)
		return
	}

	log.Printf("Fetching image '%s' for project %d, user %d", imageName, projectID, userID)

	var blob []byte
	var ownerUserID int64

	dbMutex.Lock()
	// Verify the project belongs to the user before fetching the blob
	err = db.QueryRow("SELECT user_id FROM projects WHERE id = ?", projectID).Scan(&ownerUserID)
	if err != nil {
		if err == sql.ErrNoRows {
			http.Error(w, "Project not found", http.StatusNotFound)
		} else {
			log.Printf("Error checking project owner for image request (project %d, user %d): %v", projectID, userID, err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
		}
		dbMutex.Unlock()
		return
	}

	if ownerUserID != userID {
		log.Printf("User %d attempted to access image '%s' from project %d owned by user %d", userID, imageName, projectID, ownerUserID)
		http.Error(w, "Forbidden", http.StatusForbidden)
		dbMutex.Unlock()
		return
	}

	// Fetch the image blob
	err = db.QueryRow("SELECT blob FROM images WHERE project_id = ? AND name = ?", projectID, imageName).Scan(&blob)
	dbMutex.Unlock() // Unlock before writing response

	if err != nil {
		if err == sql.ErrNoRows {
			log.Printf("Image '%s' not found for project %d", imageName, projectID)
			http.Error(w, "Image not found", http.StatusNotFound)
		} else {
			log.Printf("Error fetching image blob '%s' for project %d: %v", imageName, projectID, err)
			http.Error(w, "Failed to retrieve image", http.StatusInternalServerError)
		}
		return
	}

	// Determine content type (simple check based on extension)
	contentType := "application/octet-stream" // Default
	ext := filepath.Ext(imageName)
	switch ext {
	case ".png":
		contentType = "image/png"
	case ".jpg", ".jpeg":
		contentType = "image/jpeg"
	case ".gif":
		contentType = "image/gif"
	case ".svg":
		contentType = "image/svg+xml"
	case ".webp":
		contentType = "image/webp"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(blob)))
	w.WriteHeader(http.StatusOK)
	w.Write(blob)
}

// PUT /api/projects/{id} (Authenticated) - Sync Endpoint
func updateProjectHandler(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(userIDContextKey).(int64)
	vars := mux.Vars(r)
	projectIDStr := vars["id"]
	projectID, err := strconv.ParseInt(projectIDStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid project ID", http.StatusBadRequest)
		return
	}

	var req UpdateProjectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	log.Printf("Updating project %d ('%s') for user %d", projectID, req.Name, userID)

	dbMutex.Lock() // Lock for the duration of the transaction
	tx, err := db.Begin()
	if err != nil {
		dbMutex.Unlock()
		log.Printf("Error starting transaction for project %d update: %v", projectID, err)
		http.Error(w, "Failed to update project", http.StatusInternalServerError)
		return
	}
	// Ensure rollback on error, then unlock
	defer func() {
		if p := recover(); p != nil {
			tx.Rollback() // Rollback on panic
			dbMutex.Unlock()
			panic(p) // Re-throw panic
		} else if err != nil {
			tx.Rollback() // Rollback on error
			dbMutex.Unlock()
		} else {
			err = tx.Commit() // Commit on success
			dbMutex.Unlock()
			if err != nil {
				log.Printf("Error committing transaction for project %d update: %v", projectID, err)
				// Respond with error after unlock attempt
				// Note: This error response might not reach the client if unlock fails critically
				// but we try to send it anyway.
				http.Error(w, "Failed to save changes", http.StatusInternalServerError)
			} else {
				log.Printf("Successfully updated project %d", projectID)
				w.WriteHeader(http.StatusOK)
				json.NewEncoder(w).Encode(map[string]string{"message": "Project updated successfully"})
			}
		}
	}()

	// 1. Verify project ownership and update project details
	projectName := req.Name
	if projectName == "" {
		projectName = defaultProjectName // Or handle error
	}

	result, err := tx.Exec(
		"UPDATE projects SET name = ?, body = ?, updated_at = ? WHERE id = ? AND user_id = ?",
		projectName, req.Body, time.Now(), projectID, userID,
	)
	if err != nil {
		log.Printf("Error updating project %d details: %v", projectID, err)
		return // Defer will rollback
	}
	rowsAffected, _ := result.RowsAffected()
	if rowsAffected == 0 {
		log.Printf("Project %d not found or does not belong to user %d during update", projectID, userID)
		err = errors.New("project not found or forbidden")                       // Set error for defer rollback
		http.Error(w, "Project not found or access denied", http.StatusNotFound) // Respond before defer
		return
	}

	// 2. Synchronize images: Delete removed images, Add/Update others
	existingImages := make(map[string]bool)
	rows, err := tx.Query("SELECT name FROM images WHERE project_id = ?", projectID)
	if err != nil {
		log.Printf("Error querying existing images for project %d: %v", projectID, err)
		return // Defer will rollback
	}
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			rows.Close()
			log.Printf("Error scanning existing image name for project %d: %v", projectID, err)
			return // Defer will rollback
		}
		existingImages[name] = true
	}
	rows.Close() // Close rows before next query/exec

	requestedImages := make(map[string]ProjectUpdateImage)
	for _, img := range req.Images {
		if img.Name != "" {
			requestedImages[img.Name] = img
		}
	}

	// Delete images that exist in DB but not in the request
	for name := range existingImages {
		if _, exists := requestedImages[name]; !exists {
			log.Printf("Deleting image '%s' from project %d", name, projectID)
			_, err = tx.Exec("DELETE FROM images WHERE project_id = ? AND name = ?", projectID, name)
			if err != nil {
				log.Printf("Error deleting image '%s' from project %d: %v", name, projectID, err)
				return // Defer will rollback
			}
		}
	}

	// Add or Update images present in the request
	for name, imgData := range requestedImages {
		if imgData.BlobBase64 != "" { // Only process if blob data is provided
			blob, decodeErr := base64.StdEncoding.DecodeString(imgData.BlobBase64)
			if decodeErr != nil {
				log.Printf("Error decoding base64 for image '%s' in project %d: %v", name, projectID, decodeErr)
				err = decodeErr                                                      // Set error for defer rollback
				http.Error(w, "Invalid image data for "+name, http.StatusBadRequest) // Respond before defer
				return
			}

			if existingImages[name] {
				// Update existing image (if needed - could skip if blob unchanged, but upsert is easier)
				// log.Printf("Updating image '%s' in project %d", name, projectID)
				// _, err = tx.Exec("UPDATE images SET blob = ? WHERE project_id = ? AND name = ?", blob, projectID, name)
				// Use INSERT OR REPLACE (Upsert)
				log.Printf("Updating image '%s' in project %d", name, projectID)
				_, err = tx.Exec(
					"INSERT OR REPLACE INTO images (project_id, name, blob) VALUES (?, ?, ?)",
					projectID, name, blob,
				)
			} else {
				// Insert new image
				log.Printf("Inserting new image '%s' into project %d", name, projectID)
				_, err = tx.Exec(
					"INSERT INTO images (project_id, name, blob) VALUES (?, ?, ?)",
					projectID, name, blob,
				)
			}
			if err != nil {
				log.Printf("Error upserting image '%s' for project %d: %v", name, projectID, err)
				return // Defer will rollback
			}
		} else if !existingImages[name] {
			// Image requested without blob data, and it doesn't exist yet. This is likely an error
			// or indicates the client expects the server to keep the old blob if name matches.
			// For simplicity, we'll treat this as an error or ignore it. Ignoring for now.
			log.Printf("Image '%s' requested for project %d without blob data and doesn't exist, skipping insert.", name, projectID)
		}
	}

	// If we reach here without error, defer will commit.
}

// --- Main Function ---

func main() {
	var err error

	// Initialize session store
	// TODO: Load secret from environment variable or config file for production
	if sessionSecret == "replace-this-with-a-real-secret-key" {
		log.Println("WARNING: Using default insecure session secret key!")
	}
	sessionStore = sessions.NewCookieStore([]byte(sessionSecret))

	// Initialize database
	db, err = initDB(dbFileName)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer db.Close() // Ensure DB is closed when main exits

	// Set up router
	r := mux.NewRouter()

	// --- Public Routes ---
	r.HandleFunc("/register", registerHandler).Methods("POST")
	r.HandleFunc("/login", loginHandler).Methods("POST")
	r.HandleFunc("/logout", logoutHandler).Methods("POST")
	r.HandleFunc("/pdf", pdfHandler).Methods("POST")
	r.HandleFunc("/odt", odtHandler).Methods("POST")

	// --- Authenticated API Routes ---
	apiRouter := r.PathPrefix("/api").Subrouter()
	apiRouter.Use(authMiddleware) // Apply auth middleware to all /api routes

	apiRouter.HandleFunc("/projects", getProjectsHandler).Methods("GET")                             // List user's projects
	apiRouter.HandleFunc("/projects", createProjectHandler).Methods("POST")                          // Create a new project
	apiRouter.HandleFunc("/projects/{id}", getProjectHandler).Methods("GET")                         // Get specific project details
	apiRouter.HandleFunc("/projects/{id}", updateProjectHandler).Methods("PUT")                      // Update/Sync specific project
	apiRouter.HandleFunc("/projects/{id}/image/{image_name}", getProjectImageHandler).Methods("GET") // Get specific image blob

	// --- Static File Serving ---
	// Serve index.html at the root
	r.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
	}).Methods("GET")

	// Serve other static files (js, css, etc.)
	fs := http.FileServer(http.Dir(staticDir))
	// Use PathPrefix and StripPrefix to serve files correctly
	r.PathPrefix("/").Handler(http.StripPrefix("/", fs))

	// Start server
	port := "6969"
	log.Printf("Server starting on http://localhost:%s", port)
	err = http.ListenAndServe(":"+port, r) // Use the mux router
	if err != nil {
		log.Fatalf("Server failed to start: %v", err)
	}
}
