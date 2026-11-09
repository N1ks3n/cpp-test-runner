import * as vscode from "vscode";

export class SettingsPanel {
    private static panel: vscode.WebviewPanel | undefined;

    public static show(): void {
        if (SettingsPanel.panel) {
            SettingsPanel.panel.reveal(vscode.ViewColumn.Active);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "cppTestRunner.settings",
            "C++ Tests: Настройки",
            vscode.ViewColumn.Active,
            {
                enableScripts: false
            }
        );

        SettingsPanel.panel = panel;
        panel.webview.html = SettingsPanel.getHtml();

        panel.onDidDispose(() => {
            SettingsPanel.panel = undefined;
        });
    }

    private static getHtml(): string {
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
                    content="width=device-width, initial-scale=1.0"
                >
                <title>Настройки C++ Tests</title>

                <style>
                    body {
                        max-width: 760px;
                        margin: 0 auto;
                        padding: 24px;
                        color: var(--vscode-foreground);
                        background: var(--vscode-editor-background);
                        font-family: var(--vscode-font-family);
                        font-size: var(--vscode-font-size);
                    }

                    section {
                        margin-top: 24px;
                        padding: 20px;
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 8px;
                    }

                    .checkbox-row {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }

                    .folder-label {
                        display: block;
                        margin: 20px 0 8px;
                    }

                    input[type="text"] {
                        box-sizing: border-box;
                        width: 100%;
                        padding: 8px;
                        color: var(--vscode-input-foreground);
                        background: var(--vscode-input-background);
                        border: 1px solid var(--vscode-input-border);
                    }

                    input:focus-visible {
                        outline: 1px solid var(--vscode-focusBorder);
                        outline-offset: 2px;
                    }

                    .hint {
                        color: var(--vscode-descriptionForeground);
                    }
                </style>
            </head>

            <body>
                <h1>Настройки C++ Tests</h1>

                <p class="hint">
                    Пока это макет: значения ещё не сохраняются.
                </p>

                <section aria-labelledby="logs-heading">
                    <h2 id="logs-heading">Логи</h2>

                    <label class="checkbox-row">
                        <input id="logs-enabled" type="checkbox">
                        Сохранять логи запусков
                    </label>

                    <label class="folder-label" for="logs-directory">
                        Папка для логов
                    </label>

                    <input
                        id="logs-directory"
                        type="text"
                        placeholder="/путь/к/папке"
                    >
                </section>
            </body>
            </html>
        `;
    }
}