import * as vscode from "vscode";

export interface TestSummary {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
}

export interface RunRecord extends TestSummary {
    date: string;
    buildDirectory: string;
    durationMs: number;
    exitCode: number;
}

let panel: vscode.WebviewPanel | undefined;
let displayedProject: string | undefined;

function historyKey(folder: vscode.WorkspaceFolder): string {
    return `cppTestRunner.history:${folder.uri.toString()}`;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => {
        const replacements: Record<string, string> = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        };

        return replacements[character]!;
    });
}

function seconds(milliseconds: number): string {
    return (milliseconds / 1000).toFixed(2);
}

function render(history: RunRecord[]): string {
    const recent = history.slice(-30);
    const latest = history[history.length - 1];

    const totals = history.reduce(
        (sum, run) => ({
            passed: sum.passed + run.passed,
            failed: sum.failed + run.failed,
            skipped: sum.skipped + run.skipped
        }),
        { passed: 0, failed: 0, skipped: 0 }
    );

    const maxTotal = Math.max(1, ...recent.map((run) => run.total));
    const maxDuration = Math.max(
        1,
        ...recent.map((run) => run.durationMs)
    );

    const chartWidth = 720;
    const baseline = 150;
    const chartHeight = 120;
    const slotWidth = chartWidth / Math.max(1, recent.length);
    const barWidth = Math.max(1, slotWidth - 5);

    const resultBars = recent.map((run, index) => {
        const x = index * slotWidth;
        let y = baseline;

        const segments = [
            { count: run.passed, color: "#4caf50" },
            { count: run.failed, color: "#ef5350" },
        ];

        const rectangles = segments.map((segment) => {
            const height = segment.count / maxTotal * chartHeight;
            y -= height;

            return `
                <rect
                    x="${x}"
                    y="${y}"
                    width="${barWidth}"
                    height="${height}"
                    fill="${segment.color}"
                />
            `;
        }).join("");

        return `
            <g>
                <title>${escapeHtml(run.date)}:
                    успешно ${run.passed},
                    ошибок ${run.failed},
                </title>
                ${rectangles}
            </g>
        `;
    }).join("");

    const durationBars = recent.map((run, index) => {
        const height = run.durationMs / maxDuration * chartHeight;

        return `
            <rect
                x="${index * slotWidth}"
                y="${baseline - height}"
                width="${barWidth}"
                height="${height}"
                fill="#64b5f6"
            >
                <title>${escapeHtml(run.date)}:
                    ${seconds(run.durationMs)} с
                </title>
            </rect>
        `;
    }).join("");

    const rows = [...history].reverse().map((run) => `
        <tr>
            <td>${escapeHtml(new Date(run.date).toLocaleString())}</td>
            <td>${run.passed}</td>
            <td>${run.failed}</td>
            <td>${seconds(run.durationMs)}</td>
            <td>${run.exitCode}</td>
            <td>${escapeHtml(run.buildDirectory)}</td>
        </tr>
    `).join("");

    return /* html */ `
        <!DOCTYPE html>
        <html lang="ru">
        <head>
            <meta charset="UTF-8">
            <meta
                http-equiv="Content-Security-Policy"
                content="default-src 'none'; style-src 'unsafe-inline';"
            >
            <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
            >
            <title>Статистика C++ Tests</title>
            <style>
                body {
                    padding: 24px;
                    color: var(--vscode-foreground);
                    background: var(--vscode-editor-background);
                    font-family: var(--vscode-font-family);
                }

                .cards {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 12px;
                }

                .card, section {
                    padding: 16px;
                    margin-bottom: 16px;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 8px;
                }

                .card strong {
                    display: block;
                    margin-top: 8px;
                    font-size: 24px;
                }

                .hint {
                    color: var(--vscode-descriptionForeground);
                }

                svg {
                    display: block;
                    width: 100%;
                    max-width: 900px;
                }

                .table-container {
                    overflow-x: auto;
                }

                table {
                    width: 100%;
                    border-collapse: collapse;
                }

                th, td {
                    padding: 10px;
                    text-align: left;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }

                .passed { color: #4caf50; }
                .failed { color: #ef5350; }
                .skipped { color: #ffb74d; }
            </style>
        </head>
        <body>
            <h1>Статистика C++ Tests</h1>

            <p class="hint">
                Длительность измеряется для запуска CTest,
                без настройки CMake и компиляции.
                Итоги рассчитаны по сохранённой истории.
            </p>

            <div class="cards">
                <div class="card">
                    Запусков
                    <strong>${history.length}</strong>
                </div>
                <div class="card">
                    Успешных выполнений тестов
                    <strong class="passed">${totals.passed}</strong>
                </div>
                <div class="card">
                    Неуспешных выполнений
                    <strong class="failed">${totals.failed}</strong>
                </div>
                <div class="card">
                    Последний запуск
                    <strong>
                        ${latest ? `${seconds(latest.durationMs)} с` : "—"}
                    </strong>
                </div>
            </div>

            ${history.length === 0
                ? "<p>История пуста. Запусти тесты кнопкой C++ Tests.</p>"
                : `
                    <section>
                        <h2>Результаты по запускам</h2>
                        <p>
                            <span class="passed">Зелёный — успешно</span>,
                            <span class="failed">красный — ошибка</span>,
                        </p>
                        <p class="hint">
                            До 30 последних запусков, новые справа.
                            Максимум по шкале: ${maxTotal} тестов.
                            Наведи курсор на столбец для подробностей.
                        </p>
                        <svg
                            viewBox="0 0 720 160"
                            role="img"
                            aria-label="Результаты тестов по запускам"
                        >
                            ${resultBars}
                        </svg>
                    </section>

                    <section>
                        <h2>Длительность по запускам</h2>
                        <p class="hint">
                            Новые справа.
                            Максимум по шкале:
                            ${seconds(maxDuration)} с.
                        </p>
                        <svg
                            viewBox="0 0 720 160"
                            role="img"
                            aria-label="Длительность запусков CTest"
                        >
                            ${durationBars}
                        </svg>
                    </section>

                    <section>
                        <h2>История</h2>
                        <div class="table-container">
                            <table>
                                <thead>
                                    <tr>
                                        <th>Дата</th>
                                        <th>Успешно</th>
                                        <th>Ошибки</th>
                                        <th>Секунды</th>
                                        <th>Код CTest</th>
                                        <th>Сборка</th>
                                    </tr>
                                </thead>
                                <tbody>${rows}</tbody>
                            </table>
                        </div>
                    </section>
                `
            }
        </body>
        </html>
    `;
}

export async function saveRun(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    record: RunRecord,
    limit: number
): Promise<void> {
    const key = historyKey(folder);
    const history = context.workspaceState.get<RunRecord[]>(key, []);

    const updated = [...history, record].slice(-limit);

    await context.workspaceState.update(key, updated);

    if (panel && displayedProject === folder.uri.toString()) {
        panel.webview.html = render(updated);
    }
}

export async function showStatistics(
    context: vscode.ExtensionContext
): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];

    if (!folder) {
        vscode.window.showErrorMessage("Сначала открой папку проекта.");
        return;
    }

    const config = vscode.workspace.getConfiguration(
        "cppTestRunner",
        folder.uri
    );

    const limit = config.get<number>("statistics.historyLimit", 100);

    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        vscode.window.showErrorMessage(
            "Statistics: History Limit должно быть целым числом от 1 до 1000."
        );
        return;
    }

    const key = historyKey(folder);
    const saved = context.workspaceState.get<RunRecord[]>(key, []);
    const history = saved.slice(-limit);

    if (history.length !== saved.length) {
        await context.workspaceState.update(key, history);
    }

    if (!panel) {
        panel = vscode.window.createWebviewPanel(
            "cppTestRunner.statistics",
            "C++ Tests: Статистика",
            vscode.ViewColumn.Active,
            {
                enableScripts: false,
                localResourceRoots: []
            }
        );

        const currentPanel = panel;

        const disposal = currentPanel.onDidDispose(() => {
            panel = undefined;
            displayedProject = undefined;
        });

        context.subscriptions.push(currentPanel, disposal);
    } else {
        panel.reveal();
    }

    displayedProject = folder.uri.toString();
    panel.webview.html = render(history);
}