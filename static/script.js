import { CodeJar } from './codejar/codejar.js';
import * as db from './db.js';
import * as svg from './svg.js';
import * as port from './port.js';
import * as tokenizer from './tokenizer.js';

window.db        = db;
window.svg       = svg;
window.port      = port;
window.tokenizer = tokenizer;

// --- Global State ---
window.editor_content = ''; // Start empty, load from project or default
window.tokens = [];
window.svgs = [];
window.result = [];
let currentProjectId = null;
let currentProjectName = '';
let isLoggedIn = false;
let isWorking = false; // Debounce flag for window.work

// --- DOM Elements ---
const editorElement = document.querySelector('#editor');
const resultTab = document.getElementById('result_tab');
const projectsTab = document.getElementById('projects_tab');
const authSection = document.getElementById('auth_section');
const loginForm = document.getElementById('login_form');
const registerForm = document.getElementById('register_form');
const loginUsernameInput = document.getElementById('login_username');
const loginPasswordInput = document.getElementById('login_password');
const registerUsernameInput = document.getElementById('register_username');
const registerPasswordInput = document.getElementById('register_password');
const userStatusSection = document.getElementById('user_status');
const loggedInUsernameSpan = document.getElementById('logged_in_username');
const logoutButton = document.getElementById('logout_button');
const projectManagementSection = document.getElementById('project_management_section');
const newProjectButton = document.getElementById('new_project_button');
const saveProjectButton = document.getElementById('save_project_button');
const projectListUl = document.getElementById('project_list');
const feedbackElement = document.createElement('div'); // Element for user feedback
feedbackElement.id = 'feedback_message';
feedbackElement.style.padding = '10px';
feedbackElement.style.marginTop = '10px';
feedbackElement.style.borderRadius = '3px';
feedbackElement.style.display = 'none'; // Hidden by default
projectsTab.prepend(feedbackElement); // Add feedback element at the top of the projects tab

// --- UI Feedback ---
function showFeedback(message, isError = false) {
    feedbackElement.textContent = message;
    feedbackElement.style.backgroundColor = isError ? '#8b0000' : '#006400'; // Dark red or dark green
    feedbackElement.style.color = 'white';
    feedbackElement.style.display = 'block';
    // Automatically hide after a few seconds
    setTimeout(() => {
        feedbackElement.style.display = 'none';
    }, isError ? 5000 : 3000); // Show errors longer
}
// Make globally accessible if db.js needs them
function showError(msg) { showFeedback(msg, true); }
function showSuccess(msg) { showFeedback(msg, false); }
window.showError   = showError;
window.showSuccess = showSuccess;

// --- Code Editor Setup ---
const highlight = function(editor) { editor.innerHTML = hljs.highlight(editor.textContent, { language: 'markdown' }).value; };

const jar = CodeJar(editorElement, highlight, { tab: '    ' });

jar.onUpdate(code => {
    window.editor_content = code;
    // TODO: Avoid triggering full SVG render on every keystroke by default.
    // Maybe add a small delay or trigger manually/periodically.
    // For now, rely on the interval timer or manual save/load triggers.
});

// Set initial content (e.g., empty or default)
jar.updateCode(window.editor_content); // Initially empty

// --- API Helper ---
async function apiFetch(url, options = {}) {
    const defaultOptions = {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
    };
    const config = { ...defaultOptions, ...options };
    config.headers = { ...defaultOptions.headers, ...options.headers };

    if (config.body && typeof config.body !== 'string') {
        config.body = JSON.stringify(config.body);
    }

    try {
        const response = await fetch(url, config);

        if (!response.ok) {
            let errorBody;
            try {
                errorBody = await response.json();
            } catch (e) {
                // If response is not JSON
                console.log("Response:", response)
                errorBody = response.body;
            }
            const error = new Error(`HTTP error! Status: ${response.status}`);
            error.status = response.status;
            error.body = errorBody;
            console.error(`API Fetch Error (${response.status}) for ${url}:`, errorBody);
            throw error;
        }

        // Handle empty response body for 200/201/204 etc.
        const contentType = response.headers.get("content-type");
        if (response.status === 204 || !contentType || !contentType.includes("application/json")) {
            return null; // Or return response directly if needed
        }

        return await response.json();

    } catch (error) {
        console.error(`Network or fetch error for ${url}:`, error);
        // Don't re-throw if already an HTTP error from above
        if (!error.status) {
            throw new Error(`Network error: ${error.message}`);
        }
        throw error; // Re-throw the augmented HTTP error
    }
}


// --- Authentication ---
async function handleLogin(event) {
    event.preventDefault();
    const username = loginUsernameInput.value;
    const password = loginPasswordInput.value;
    if (!username || !password) {
        showError("Please enter username and password.");
        return;
    }
    try {
        await apiFetch('/login', {
            method: 'POST',
            body: { username, password },
        });
        isLoggedIn = true;
        updateAuthUI(username);
        await fetchAndDisplayProjects();
        showSuccess(`Logged in as ${username}`);
        // Optionally load the first project or clear the editor
        resetEditorAndDb(); // Clear current state after login
    } catch (error) {
        isLoggedIn = false;
        updateAuthUI();
        if (error.status === 401) {
            showError("Invalid username or password.");
        } else {
            showError(`Login failed: ${error.message}`);
        }
    }
}

async function handleRegister(event) {
    event.preventDefault();
    const username = registerUsernameInput.value;
    const password = registerPasswordInput.value;
    if (!username || !password) {
        showError("Please enter username and password.");
        return;
    }
    if (password.length < 6) { // Example: Basic password length check
        showError("Password must be at least 6 characters long.");
        return;
    }
    try {
        await apiFetch('/register', {
            method: 'POST',
            body: { username, password },
        });
        showSuccess("Registration successful! Please log in.");
        // Clear registration form
        registerForm.reset();
        // Optionally switch focus to login form
        loginUsernameInput.focus();
    } catch (error) {
        if (error.status === 409) { // Conflict - username taken
            showError("Username already taken. Please choose another.");
        } else {
            showError(`Registration failed: ${error.message}`);
        }
    }
}

async function handleLogout() {
    try {
        await apiFetch('/logout', { method: 'POST' });
        isLoggedIn = false;
        currentProjectId = null;
        currentProjectName = '';
        updateAuthUI();
        resetEditorAndDb();
        showSuccess("Logged out successfully.");
    } catch (error) {
        showError(`Logout failed: ${error.message}`);
        // Still update UI assuming logout happened or session is invalid
        isLoggedIn = false;
        updateAuthUI();
        resetEditorAndDb();
    }
}

function updateAuthUI(username = null) {
    if (isLoggedIn && username) {
        authSection.style.display = 'none';
        userStatusSection.style.display = 'flex'; // Use flex to match CSS
        projectManagementSection.style.display = 'block';
        loggedInUsernameSpan.textContent = username;
    } else {
        authSection.style.display = 'block';
        userStatusSection.style.display = 'none';
        projectManagementSection.style.display = 'none';
        loggedInUsernameSpan.textContent = '';
        projectListUl.innerHTML = ''; // Clear project list on logout
    }
}

async function checkLoginStatus() {
    try {
        // Attempt to fetch projects. If successful, user is logged in.
        // We don't need the project data here, just the success/failure.
        await apiFetch('/api/projects'); // Uses GET by default
        isLoggedIn = true;
        // Need to know the username - could add a dedicated '/api/userinfo' endpoint
        // or fetch projects and infer from potential ownership (less ideal)
        // For now, show generic logged-in state until first project load or specific user info endpoint
        updateAuthUI("User"); // Placeholder username
        await fetchAndDisplayProjects();
        console.info("User is logged in.");
    } catch (error) {
        if (error.status === 401) {
            // User is not logged in
            isLoggedIn = false;
            updateAuthUI();
            console.info("User is not logged in.");
        } else {
            // Other error (network, server issue)
            showError(`Failed to check login status: ${error.message}`);
            isLoggedIn = false;
            updateAuthUI();
        }
    }
}

function resetEditorAndDb() {
    currentProjectId = null;
    currentProjectName = '';
    jar.updateCode(''); // Clear editor
    db.clearAllImages().catch(err => showError(`Error clearing local images: ${err.message}`));
    db.populate_image_select(); // Update image dropdown (will be empty)
    resultTab.innerHTML = ''; // Clear result preview
}


// --- Project Management ---
async function fetchAndDisplayProjects() {
    if (!isLoggedIn) return;
    try {
        const projects = await apiFetch('/api/projects');
        displayProjectList(projects || []);
    } catch (error) {
        showError(`Failed to fetch projects: ${error.message}`);
        // If unauthorized, log out locally
        if (error.status === 401) {
            isLoggedIn = false;
            updateAuthUI();
            resetEditorAndDb();
        }
    }
}

function displayProjectList(projects) {
    projectListUl.innerHTML = ''; // Clear existing list
    if (!projects || projects.length === 0) {
        projectListUl.innerHTML = '<li>No projects found.</li>';
        return;
    }
    projects.forEach(project => {
        const li = document.createElement('li');
        li.dataset.projectId = project.id; // Store ID on the element

        const nameSpan = document.createElement('span');
        nameSpan.textContent = project.name;
        li.appendChild(nameSpan);

        const loadButton = document.createElement('button');
        loadButton.textContent = 'Load';
        loadButton.classList.add('load_project_btn'); // Add class for event delegation
        li.appendChild(loadButton);

        // TODO: Add Delete Button functionality if needed
        // const deleteButton = document.createElement('button');
        // deleteButton.textContent = 'Delete';
        // deleteButton.classList.add('delete_project_btn');
        // li.appendChild(deleteButton);

        projectListUl.appendChild(li);
    });
}

async function loadProject(projectId) {
    if (!projectId) return;
    showFeedback("Loading project..."); // Show loading indicator
    try {
        // 1. Fetch project details (name, body, image names)
        const projectData = await apiFetch(`/api/projects/${projectId}`);
        if (!projectData) throw new Error("Project data not received.");

        currentProjectId = projectId;
        currentProjectName = projectData.name;
        jar.updateCode(projectData.body || ''); // Update editor content

        // 2. Clear local IndexedDB images
        await db.clearAllImages();

        // 3. Fetch and store images
        if (projectData.image_names && projectData.image_names.length > 0) {
            const imagePromises = projectData.image_names.map(async (imageName) => {
                try {
                    const response = await fetch(`/api/projects/${projectId}/image/${encodeURIComponent(imageName)}`);
                    if (!response.ok) {
                        throw new Error(`Failed to fetch image ${imageName}: ${response.statusText}`);
                    }
                    const blob = await response.blob();
                    await db.store_image({ name: imageName, blob: blob });
                    console.info(`Loaded and stored image: ${imageName}`);
                } catch (imgError) {
                    console.error(`Error loading image ${imageName}:`, imgError);
                    showError(`Could not load image: ${imageName}`); // Notify user about specific image failure
                }
            });
            await Promise.all(imagePromises); // Wait for all images to be fetched and stored
        }

        // 4. Update UI (image select dropdown)
        await db.populate_image_select();

        // 5. Trigger SVG re-render
        await window.work(); // Ensure work() is awaited if it's async

        showSuccess(`Project "${projectData.name}" loaded.`);

    } catch (error) {
        showError(`Failed to load project ${projectId}: ${error.message}`);
        currentProjectId = null; // Reset state on failure
        currentProjectName = '';
        // Optionally clear editor/DB again on load failure
        // resetEditorAndDb();
    } finally {
        // Hide loading indicator if one was shown explicitly
    }
}

async function saveProject() {
    if (!isLoggedIn) {
        showError("You must be logged in to save.");
        return;
    }
    if (!currentProjectId) {
        showError("No project loaded. Load a project or create a new one before saving.");
        return;
    }

    showFeedback("Saving project...");

    try {
        // 1. Get current editor content
        const bodyContent = window.editor_content;

        // 2. Get all images from local IndexedDB
        const localImages = await db.getAllImages();

        // 3. Convert image blobs to Base64
        const imagesPayload = [];
        const conversionPromises = localImages.map(async (img) => {
            try {
                const base64 = await db.blobToBase64(img.blob);
                imagesPayload.push({ name: img.name, blob_base64: base64 });
            } catch (conversionError) {
                console.error(`Error converting blob to base64 for ${img.name}:`, conversionError);
                // Decide how to handle: skip image, show error, etc.
                // Skipping for now, but showing an error is better.
                showError(`Could not process image "${img.name}" for saving.`);
            }
        });
        await Promise.all(conversionPromises); // Wait for all conversions

        // 4. Send PUT request
        const payload = {
            name: currentProjectName, // Send the current name back
            body: bodyContent,
            images: imagesPayload,
        };

        await apiFetch(`/api/projects/${currentProjectId}`, {
            method: 'PUT',
            body: payload,
        });

        showSuccess(`Project "${currentProjectName}" saved successfully.`);

    } catch (error) {
        showError(`Failed to save project: ${error.message}`);
        if (error.status === 401) { // Handle session expiry during save
            isLoggedIn = false;
            updateAuthUI();
            resetEditorAndDb();
        }
    }
}

async function handleNewProject() {
    if (!isLoggedIn) {
        showError("You must be logged in to create a project.");
        return;
    }
    const projectName = prompt("Enter a name for the new project:", "New Project");
    if (!projectName) {
        showFeedback("Project creation cancelled.");
        return;
    }

    showFeedback("Creating new project...");

    try {
        const newProject = await apiFetch('/api/projects', {
            method: 'POST',
            body: {
                name: projectName,
                body: "...", // Start with default content?
            },
        });

        if (!newProject || !newProject.projectId) {
            throw new Error("Server did not return a valid project ID.");
        }

        showSuccess(`Project "${newProject.name}" created.`);

        // Automatically load the new project
        await loadProject(newProject.projectId);

        // Refresh the project list
        await fetchAndDisplayProjects();

    } catch (error) {
        if (error.status === 409) {
            showError(`Project name "${projectName}" already exists.`);
        } else {
            showError(`Failed to create project: ${error.message}`);
        }
        if (error.status === 401) { // Handle session expiry
            isLoggedIn = false;
            updateAuthUI();
            resetEditorAndDb();
        }
    }
}


// --- SVG Rendering ---
async function work() {
    // Debounce or prevent concurrent execution
    if (isWorking) return;
    isWorking = true;
    // console.log("Starting work...");

    try {
        window.tokens = tokenizer.tokenizeReport(window.editor_content || '');
        window.svgs = await svg.parse(window.tokens); // parse is async due to images
        window.result = window.svgs.map(rs => svg.evaluate(rs));

        if (resultTab) {
            resultTab.innerHTML = ''; // Clear previous results
            for (let i = 0; i < window.result.length; i += 1) {
                // Sanitize SVG slightly before adding? Basic check:
                if (typeof window.result[i] === 'string' && window.result[i].trim().startsWith('<svg')) {
                    resultTab.innerHTML += window.result[i] + '\n';
                } else {
                    console.warn("Skipping invalid SVG result for page", i);
                }
            }
        } else {
            console.error("Result tab element not found!");
        }
    } catch (error) {
        console.error("Error during SVG generation work:", error);
        showError(`SVG Rendering Error: ${error.message}`);
        if (resultTab) resultTab.innerHTML = '<p style="color: red;">Error generating preview.</p>';
    } finally {
        // console.log("Finished work.");
        isWorking = false; // Release debounce flag
    }
};
window.work = work;

function get_test_content() {
    // {{{
    return `# Heading

A paragraph, with some text.

A multi-line paragraph
that is only written multi-line,
not actually.

And a list for good measure:
. Item 1
.. Item 1.1
. Item 2

A paragraph, with some text.

image::ded[Клиент‑серверная архитектура]

# TODO

## Code block

\`\`\`gleam
pub fn convert(doc: String) -> Result(Svg, String) {
let svg = asciidoc_to_svg(doc)
case svg {
Ok(data) -> save_to_file(data, "output.svg")
Error(reason) -> Error("Conversion failed: " <> reason)
}
}
\`\`\`

## A Table

[cols="1,2,2", options="header", bool-opt-1, bool-opt-2, key="value"]
|===
| ID | Название | Описание
| 001 | Lorem Ipsum | Lorem ipsum dolor sit amet, consectetur adipiscing elit.
| 002 | Dolor Sit | Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
| 003 | Amet Consectetur | Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.
| 004 | Adipiscing Elit | Duis aute irure dolor in reprehenderit in voluptate velit esse.
|===
`
    // }}}
}

function _get_test_content() {
    // {{{
    return `
#@ РЕФЕРАТ

Отчёт 15 страниц, 5 рисунков, 15 источников

ИНТЕРНЕТ, РАЗРАБОТКА, ВЕБ‑ТЕХНОЛОГИИ, ASCIIDOC, GLEAM, ACE, SVG, PDF

Объект исследования – веб‑приложение для редактирования и конвертации документов формата Asciidoc.

Предмет исследования – процесс разработки, создания и функционирования веб‑приложения для работы с Asciidoc.

Цель работы – разработка архитектуры и прототипа веб‑приложения, позволяющего редактировать документы в формате Asciidoc и конвертировать их в SVG и PDF с соблюдением ГОСТ.

В ходе работы был проведён анализ существующих форматов разметки и инструментов для работы с ними. Рассмотрен процесс создания веб‑приложения, включая выбор архитектуры, используемого программного обеспечения и инструментов разработки.

Результатом работы является прототип веб‑приложения, который обеспечивает удобное редактирование и просмотр документов в реальном времени, а также экспорт в форматы SVG и PDF. Приложение демонстрирует высокую производительность и удобство использования, что позволяет ему конкурировать с существующими инструментами для работы с документами в сети интернет.

#% Содержание

#@ ВВЕДЕНИЕ

В данной курсовой работе рассматривается разработка и анализ архитектуры веб‑приложения для редактирования и конвертации документов в формате Asciidoc. Целью данного приложения является упрощение работы с технической документацией и отчётами, автоматизируя процесс преобразования документов в форматы SVG и PDF с соблюдением стандартов ГОСТ.

Актуальность выбранной темы обусловлена растущей популярностью форматов разметки для создания структурированных текстов и недостатком удобных инструментов для работы с Asciidoc, особенно в контексте применения национальных стандартов. Существующие решения либо слишком сложны в использовании, либо не предоставляют необходимых функций для быстрой и качественной конвертации.

Целью данной курсовой работы является разработка архитектуры и прототипа веб‑приложения, предоставляющего удобный интерфейс для работы с Asciidoc и позволяющего экспортировать документы в популярные форматы с сохранением всех структурных элементов.

Для достижения цели были поставлены следующие задачи:

- изучить формат Asciidoc и его применение в современных рабочих процессах;
- провести анализ существующих инструментов для работы с Asciidoc и определить их преимущества и недостатки;
- разработать архитектуру приложения, включающую клиентскую и серверную части;
- спроектировать потоки данных для обработки документов и экспорта их в SVG и PDF;
- выбрать и обосновать используемые технологии, такие как Gleam для серверной части, Ace Editor для клиентского редактора, а также инструменты для конвертации форматов;
- реализовать минимальный жизнеспособный прототип приложения с базовым функционалом, включая редактирование текста, предварительный просмотр и экспорт;
- провести тестирование производительности, удобства использования и соответствия заявленным требованиям.

# Описание предметной области

## Анализ формата Asciidoc

Формат Asciidoc[1] представляет собой мощный текстовый формат разметки, который применяется для создания технической документации, статей, презентаций и других типов текстовых документов. Его основным преимуществом является поддержка сложных структур, таких как таблицы, списки, врезки и изображения, что делает его более функциональным по сравнению с Markdown[2].

Преимущества Asciidoc:

- гибкость и возможность расширения;
- поддержка различных форматов экспорта (HTML, PDF, DocBook и др.);
- простой и читабельный синтаксис.

## Обоснование выбора Asciidoc

На основании анализа существующих решений было принято решение использовать Asciidoc в качестве основного формата для приложения. Среди альтернатив рассматривались LaTeX[3] и Markdown, однако:

- LaTeX сложен в освоении и требует установки специфического программного обеспечения;
- Markdown обладает более ограниченным функционалом, чем Asciidoc.

## Функциональные требования к системе

Для реализации веб‑приложения необходимо обеспечить следующие возможности:

- редактирование текста в формате Asciidoc через встроенный редактор Ace Editor;
- просмотр результатов в реальном времени в формате SVG;
- экспорт документа в форматы SVG[5] и PDF с соблюдением стандартов ГОСТ;
- минимизация запросов к серверу (клиент обрабатывает предварительный просмотр, сервер — экспорт).

## Нефункциональные требования к системе

- время обработки текста (SVG/PDF) не должно превышать 3 секунд для документов объёмом 10–20 страниц;
- интуитивно понятный минималистичный интерфейс для десктопа и мобильных устройств;
- кроссплатформенность (Chrome, Firefox, Safari, Edge);
- масштабируемость кода для добавления новых функций;
- безопасность: HTTPS и отсутствие хранения личных данных пользователей.

## Ограничения системы

- серверная часть написана на Gleam, что ограничивает выбор библиотек;
- поддерживается только Asciidoc как формат входных данных;
- отсутствует система хранения и истории документов;
- возможны задержки при обработке документов более 100 страниц;
- нет поддержки совместного редактирования.

# Проектирование архитектуры

## Выбранная архитектура

Архитектура приложения — клиент‑серверная модель SPA. Клиент (Ace Editor + JS) конвертирует Asciidoc в SVG для предпросмотра, сервер (Gleam) — в PDF.

//image::blob:http://localhost:42069/d4deb6f7-124f-4efe-ba74-9968870ab851[Клиент‑серверная архитектура]

### Составляющие архитектуры

- **Клиентская часть**: Ace Editor для подсветки и редактирования Asciidoc;
- **Серверная часть**: Gleam — обработка данных и конвертация SVG→PDF;
- **Хранилище данных**: пока отсутствует (MVP), в будущем SQLite[7].

## Будущие улучшения

Переход на The Elm Architecture для более чёткого управления состоянием:

//image::blob:http://localhost:42069/73c43758-506c-45c8-b4f4-020941e66ae9[Архитектура TEA]

# Реализация MVP

## Основные функции

- редактирование Asciidoc;
- предпросмотр SVG;
- экспорт SVG/PDF.

Используемые технологии:

- Ace Editor;
- JS‑конвертация Asciidoc→SVG;
- Gleam для сервера;
- GNU awk для разбивки страниц SVG;
- svg2pdf для одной страницы SVG;
- GhostScript для объединения в PDF.

# Инфраструктура

Используется домашний сервер на Void Linux[13] и Ngrok[14] для публичного доступа.

- **Void Linux**: минимализм и контроль над ресурсами;
- **Ngrok**: проброс локального порта в интернет;
- **Браузер**: клиентское приложение.

# Иллюстрация последовательности действий

//image::blob:http://localhost:42069/c1c8949f-e689-466d-b14f-e51f0075809b[Диаграмма последовательности]

# Потоки данных (DFD)

## Описание потоков данных

- Asciidoc→SVG→клиент;
- Asciidoc→SVG→PDF→клиент.

## Иллюстрация потоков данных

//image::blob:http://localhost:42069/2c07074f-9287-467e-b063-b963073120c5[Диаграмма потока данных]

# Тестирование

## Тестирование UX/UI

//image::blob:http://localhost:42069/560c829b-02c6-4046-85cc-7314a643396f[Скриншот работы сайта]

## Проверка функциональности

- конвертация Asciidoc→SVG;
- конвертация SVG→PDF;
- соответствие ГОСТ.

## Результаты тестирования

- время обработки запросов;
- корректность отображения;
- отсутствие ошибок при экспорте.

#@ Заключение

Приложение обеспечивает удобное редактирование Asciidoc, масштабируемую архитектуру и экспорт по ГОСТ. Код хранится в локальном репозитории и на GitHub[15].

В планах:

- внедрение аккаунтов пользователей;
- поддержка дополнительных форматов;
- оптимизация производительности.

#@ СПИСОК ИСТОЧНИКОВ И ЛИТЕРАТУРЫ

. Asciidoc [Электронный ресурс]. – URL: https://asciidoc.org/ (дата обращения 09.12.2024).
. MarkDown [Электронный ресурс]. – URL: https://www.markdownguide.org/ (дата обращения 09.12.2024).
. LaTeX [Электронный ресурс]. – URL: https://www.latex-project.org/ (дата обращения 09.12.2024).
. Ace Editor [Электронный ресурс]. – URL: https://ace.c9.io/ (дата обращения 09.12.2024).
. SVG [Электронный ресурс]. – URL: https://www.w3.org/Graphics/SVG/ (дата обращения 09.12.2024).
. Gleam [Электронный ресурс]. – URL: https://gleam.run/ (дата обращения 09.12.2024).
. SQLite [Электронный ресурс]. – URL: https://www.sqlite.org/index.html (дата обращения 09.12.2024).
. Elm [Электронный ресурс]. – URL: https://elm-lang.org/ (дата обращения 09.12.2024).
. GNU awk [Электронный ресурс]. – URL: https://www.gnu.org/software/gawk/manual/gawk.html (дата обращения 09.12.2024).
. svg2pdf [Электронный ресурс]. – URL: https://github.com/typst/svg2pdf (дата обращения 09.12.2024).
. GhostScript [Электронный ресурс]. – URL: https://www.ghostscript.com/ (дата обращения 09.12.2024).
. MDN [Электронный ресурс]. – URL: https://developer.mozilla.org/en-US/ (дата обращения 09.12.2024).
. Void Linux [Электронный ресурс]. – URL: https://voidlinux.org/ (дата обращения 09.12.2024).
. Ngrok [Электронный ресурс]. – URL: https://ngrok.com/docs (дата обращения 09.12.2024).
. GitHub [Электронный ресурс]. – URL: https://github.com/ (дата обращения 09.12.2024).
`
    // }}}
}

// --- Initial Setup & Event Listeners ---
;(function setup_listeners() {
    console.log("DOM Loaded. Initializing...");

    // Setup Tab Switching Logic (keep existing)
    const tab_buttons = document.querySelectorAll('.tab_button');
    const tab_contents = document.querySelectorAll('.tab_content');
    tab_buttons.forEach(button => {
        button.addEventListener('click', () => {
            const target_id = button.getAttribute('data-tab');
            tab_buttons.forEach(btn => btn.classList.remove('active'));
            tab_contents.forEach(tab => tab.classList.remove('active'));
            button.classList.add('active');
            const targetTab = document.getElementById(target_id);
            if (targetTab) targetTab.classList.add('active');
        });
    });

    // Setup Export Buttons (keep existing)
    const export_svg_btn = document.querySelector('#export_svg_btn');
    const export_pdf_btn = document.querySelector('#export_pdf_btn');
    const export_odt_btn = document.querySelector('#export_odt_btn');
    export_svg_btn?.addEventListener('click', port.export_svg);
    export_pdf_btn?.addEventListener('click', port.export_pdf);
    export_odt_btn?.addEventListener('click', port.export_odt);

    // Authentication Listeners
    loginForm?.addEventListener('submit', handleLogin);
    registerForm?.addEventListener('submit', handleRegister);
    logoutButton?.addEventListener('click', handleLogout);

    // Project Management Listeners
    newProjectButton?.addEventListener('click', handleNewProject);
    saveProjectButton?.addEventListener('click', saveProject);

    // Project List Listener (Event Delegation)
    projectListUl?.addEventListener('click', (event) => {
        if (event.target.classList.contains('load_project_btn')) {
            const listItem = event.target.closest('li');
            if (listItem && listItem.dataset.projectId) {
                const projectId = parseInt(listItem.dataset.projectId, 10);
                if (!isNaN(projectId)) {
                    loadProject(projectId);
                }
            }
        }
        // Add handling for delete buttons here if implemented
        // if (event.target.classList.contains('delete_project_btn')) { ... }
    });

    // Check login status when the app loads
    checkLoginStatus();

    // Initial SVG render
    jar.updateCode(get_test_content());
    window.work();

    // Interval timer for automatic SVG refresh
    setInterval(async () => {
        // TODO: check whether editor has changed
        await window.work();
    }, 1000);

    console.log("Initialization complete.");
})();
