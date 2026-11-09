import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
    const command = vscode.commands.registerCommand(
        "cppTestRunner.runTests",
        () => {
            vscode.window.showInformationMessage(
                "C++ Test Runner готов к запуску тестов!"
            );
        }
    );

    context.subscriptions.push(command);
}