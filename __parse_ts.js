const ts = require('typescript');
const fs = require('fs');
const source = fs.readFileSync('src/components/EditorPage.tsx', 'utf8');
const fileName = 'src/components/EditorPage.tsx';
const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([fileName], { noEmit: true, allowJs: true, jsx: ts.JsxEmit.Preserve, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, allowSyntheticDefaultImports: true, esModuleInterop: true }), sourceFile);
console.log('diagnostics count', diagnostics.length);
for (const diag of diagnostics) {
  const { line, character } = diag.file.getLineAndCharacterOfPosition(diag.start);
  const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
  console.log(`${diag.file.fileName}:${line+1}:${character+1} - ${message}`);
}
