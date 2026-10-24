import ts from 'typescript';

export type FnInfo = { name: string; params: string[]; async: boolean };
export type Compiled = {
  js: string;
  fns: FnInfo[];
  diagnostics: { line: number; message: string }[];
};

const isAsync = (n: ts.Node) => !!(ts as unknown as { getModifiers?: (n: ts.Node) => readonly ts.Modifier[] | undefined }).getModifiers?.(n)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
const paramNames = (ps: readonly ts.ParameterDeclaration[]) => ps.map((p) => (ts.isIdentifier(p.name) ? p.name.text : 'destructured'));

/*
 TypeScript -> runnable JavaScript, using the real compiler.
 Also discovers the top-level functions so the runtime can pick an entry point
 without knowing any names in advance.
*/
export function compileTs(code: string): Compiled {
  const out = ts.transpileModule(code, {
    reportDiagnostics: true,
    fileName: 'node.ts',
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });

  const diagnostics = (out.diagnostics ?? []).slice(0, 5).map((d) => ({
    line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0,
    message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
  }));

  const sf = ts.createSourceFile('node.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const fns: FnInfo[] = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) {
      fns.push({ name: st.name.text, params: paramNames(st.parameters), async: isAsync(st) });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          fns.push({ name: d.name.text, params: paramNames(init.parameters), async: isAsync(init) });
        }
      }
    }
  }

  const footer = `\nexport const __fns__ = { ${fns.map((f) => `${JSON.stringify(f.name)}: ${f.name}`).join(', ')} };\n`;
  return { js: out.outputText + footer, fns, diagnostics };
}