const ts = require('typescript');
const fs = require('fs');
const source = fs.readFileSync('src/components/EditorPage.tsx', 'utf8');
const fileName = 'src/components/EditorPage.tsx';
const program = ts.createProgram([fileName], {
  noEmit: true,
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ESNext,
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
  skipLibCheck: true,
});
const sourceFile = program.getSourceFile(fileName);
const diagnostics = ts.getPreEmitDiagnostics(program, sourceFile);
console.log('diagnostics count', diagnostics.length);
for (const diag of diagnostics) {
  const { line, character } = diag.file ? diag.file.getLineAndCharacterOfPosition(diag.start) : { line: 0, character: 0 };
  const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
  console.log(`${diag.file ? diag.file.fileName : fileName}:${line+1}:${character+1} - ${message}`);
}
