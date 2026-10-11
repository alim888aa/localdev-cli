import ts from "typescript";

const PRIVATE_PATH = 1;
const STORED_VALUE = 2;
const reads = new Set(["readFile", "readFileSync", "readdir", "readdirSync"]);
const probes = new Set(["access", "accessSync", "stat", "statSync", "lstat", "lstatSync", "exists", "existsSync"]);
const callbackAssertions = new Set(["throws", "doesNotThrow", "rejects", "doesNotReject"]);
const privateText = (text) => /(^|[/\\])sessions([/\\]|$)|(^|[/\\])receipt\.json(?:\.[a-z\d.-]+)?$/.test(text);

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function scopeOf(node) {
  const scope = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent) && /^(test|it|describe)$/.test(parent.expression.getText())) {
      scope.push(parent.arguments[0]?.getText() ?? "");
    } else if (ts.isFunctionLike(parent)) {
      const name = parent.name ?? parent.parent?.name;
      if (name) scope.push(name.getText());
    }
  }
  return scope.reverse().join("/");
}

/** Find assertion inputs derived from private session storage, without exempting setup files. */
export function testStorageFindings(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const program = ts.createProgram([file], { allowJs: true, noResolve: true, noLib: true }, {
    getSourceFile: (name) => name === file ? source : undefined,
    getDefaultLibFileName: () => "", writeFile() {}, getCurrentDirectory: () => "",
    getDirectories: () => [], fileExists: (name) => name === file,
    readFile: (name) => name === file ? text : undefined,
    getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  });
  const checker = program.getTypeChecker();
  const assigned = new Map();
  walk(source, (node) => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const symbol = checker.getSymbolAtLocation(node.left);
    if (!symbol) return;
    if (!assigned.has(symbol)) assigned.set(symbol, []);
    assigned.get(symbol).push(node.right);
  });
  const assertions = new Map();
  const assertionNamespaces = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !/^node:assert(?:\/strict)?$/.test(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name) assertionNamespaces.add(checker.getSymbolAtLocation(clause.name));
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      assertionNamespaces.add(checker.getSymbolAtLocation(clause.namedBindings.name));
    } else for (const item of clause?.namedBindings?.elements ?? []) assertions.set(checker.getSymbolAtLocation(item.name), (item.propertyName ?? item.name).text);
  }

  function declarationOf(node) {
    let declaration = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node)?.valueDeclaration;
    if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
      declaration = checker.getShorthandAssignmentValueSymbol(declaration)?.valueDeclaration;
    }
    return declaration;
  }

  function value(node, bindings = new Map(), seen = new Set()) {
    if (!node || seen.has(node)) return 0;
    const next = new Set(seen).add(node);
    if (ts.isFunctionLike(node)) return 0;
    if (ts.isStringLiteralLike(node)) return privateText(node.text) ? PRIVATE_PATH : 0;
    if (ts.isTemplateExpression(node) && privateText([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("/"))) return PRIVATE_PATH;
    if (ts.isShorthandPropertyAssignment(node)) return value(checker.getShorthandAssignmentValueSymbol(node)?.valueDeclaration?.initializer, bindings, next);
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (bindings.has(symbol)) return bindings.get(symbol);
      const declaration = symbol?.valueDeclaration;
      let result = value(declaration?.initializer, bindings, next);
      if (declaration && ts.isBindingElement(declaration)) {
        result |= value(declaration.parent.parent.initializer, bindings, next);
      }
      for (const assignment of assigned.get(symbol) ?? []) result |= value(assignment, bindings, next);
      return result;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const declaration = declarationOf(node);
      return value(declaration?.initializer, bindings, next) | value(node.expression, bindings, next);
    }
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText();
      const inputs = node.arguments.map((argument) => value(argument, bindings, next));
      const combined = inputs.reduce((a, b) => a | b, 0);
      if (reads.has(name) && inputs[0] & PRIVATE_PATH) return STORED_VALUE;
      if (probes.has(name) && inputs[0] & PRIVATE_PATH) return PRIVATE_PATH;
      let declaration = declarationOf(node.expression);
      if (declaration?.initializer) declaration = declaration.initializer;
      if (declaration && ts.isFunctionLike(declaration) && declaration.body) {
        const parameters = new Map(bindings);
        declaration.parameters.forEach((parameter, index) => {
          parameters.set(checker.getSymbolAtLocation(parameter.name), inputs[index] ?? 0);
        });
        if (!ts.isBlock(declaration.body)) return value(declaration.body, parameters, next);
        let result = 0;
        const returns = (child) => {
          if (ts.isReturnStatement(child)) result |= value(child.expression, parameters, next);
          else if (!ts.isFunctionLike(child)) ts.forEachChild(child, returns);
        };
        returns(declaration.body);
        return result;
      }
      return combined | value(node.expression, bindings, next);
    }
    let result = 0;
    ts.forEachChild(node, (child) => { result |= value(child, bindings, next); });
    return result;
  }

  function callbackValue(argument) {
    if (!argument) return 0;
    let callback = argument;
    while (ts.isParenthesizedExpression(callback)) callback = callback.expression;
    if (!callback || !ts.isFunctionLike(callback)) {
      callback = declarationOf(callback);
      if (callback?.initializer) callback = callback.initializer;
    }
    if (!callback || !ts.isFunctionLike(callback) || !callback.body) return 0;
    let result = 0;
    function executed(node) {
      if (ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText();
        const taint = value(node);
        if (reads.has(name) || probes.has(name) || taint & STORED_VALUE) result |= taint;
      }
      if (ts.isReturnStatement(node) || ts.isThrowStatement(node) || ts.isIfStatement(node)) result |= value(node.expression);
      ts.forEachChild(node, executed);
    }
    if (ts.isBlock(callback.body)) executed(callback.body);
    else result = value(callback.body);
    return result;
  }

  const findings = [];
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.expression : callee);
    if (!assertions.has(symbol) && !assertionNamespaces.has(symbol)) return;
    let taint = node.arguments.reduce((result, argument) => result | value(argument), 0);
    const operation = ts.isPropertyAccessExpression(callee) ? callee.name.text : assertions.get(symbol);
    if (callbackAssertions.has(operation)) taint |= callbackValue(node.arguments[0]);
    if (!taint) return;
    const rule = "test/public-api";
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const message = taint & STORED_VALUE ? "assertion reads private stored values; use the owner's exports or CLI output"
      : "assertion reconstructs a private session path; use a path supplied by the public result or callback";
    findings.push({ rule, file, line, identity: `${scopeOf(node)}\n${node.getText()}`, message });
  });
  return findings;
}
