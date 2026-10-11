import path from "node:path";
import ts from "typescript";

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const entries = new Set(["supervisor", "guard", "proxy-process", "outbound-preload"]);
const layers = [
  ["cli"], ["session", "fault", "issue"], ["launch", "proxy", "adapter"],
  ["supervised", "state"], ["listener", "process-table", "temp-dir", "run-sync", "checkout"],
];
const ranks = new Map(layers.flatMap((names, index) => names.map((name) => [name, index])));
const owner = (file) => file.startsWith("src/") ? path.basename(file).replace(CODE, "") : null;

function resolveModule(files, from, specifier) {
  if (!specifier.startsWith(".")) return null;
  let target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (target.startsWith("dist/")) target = `src/${target.slice(5)}`;
  const stem = target.replace(CODE, "");
  const candidates = [target, ...[".ts", ".mts", ".cts", ".mjs", ".cjs", ".js", ".tsx", ".jsx"].map((extension) => stem + extension),
    ...["index.ts", "index.mjs", "index.js"].map((name) => `${target}/${name}`)];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

/** Resolve local imports and report upward edges, process-entry imports and cycles. */
export function importFindings(files) {
  const edges = [];
  for (const [file, text] of files) {
    if (!CODE.test(file)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function visit(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier = node.moduleReference.expression;
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText() === "require")) {
        specifier = node.arguments[0];
      }
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const target = resolveModule(files, file, specifier.text);
        if (target) edges.push({ file, target, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          identity: `${node.getText()}\n${target}`, message: `${file} imports ${target}` });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const graph = new Map();
  for (const edge of edges) {
    if (!graph.has(edge.file)) graph.set(edge.file, []);
    graph.get(edge.file).push(edge.target);
  }
  function reaches(from, target, seen = new Set()) {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (graph.get(from) ?? []).some((next) => reaches(next, target, seen));
  }
  const findings = [];
  for (const edge of edges) {
    const from = ranks.get(owner(edge.file));
    const to = ranks.get(owner(edge.target));
    if (entries.has(owner(edge.target))) findings.push({ ...edge, rule: "imports/process-entry" });
    if (from !== undefined && to !== undefined && from > to) findings.push({ ...edge, rule: "imports/direction" });
    if (reaches(edge.target, edge.file)) findings.push({ ...edge, rule: "imports/cycle" });
  }
  return findings;
}
