/**
 * The observer's build fingerprint: SHA-256 over the code that takes and
 * reduces an observation (`OBSERVER_SOURCES`), resolved next to
 * `@sfab-bench/sim/observe`. No package version is read: a change to that
 * code changes the fingerprint whether or not a version moved.
 *
 * The code is hashed as its syntax tree, not its bytes: each node's kind,
 * with the text of names and literals and the operator of a unary
 * expression. Whitespace, comments, semicolons, trailing commas, quote
 * style and grouping parentheses are not in the tree, so a format pass or a
 * comment edit is the same comparison. Any change to the tree is not.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Bytes } from "@sfab-bench/parts";
import { OBSERVER_SOURCES } from "@sfab-bench/sim/observe";
import ts from "typescript";

/** Where the observer's sources are, for a caller that hashes a copy. */
export function observerDir(): string {
  return dirname(fileURLToPath(import.meta.resolve("@sfab-bench/sim/observe")));
}

export function observerBuild(dir = observerDir()): string {
  return sha256Bytes(new TextEncoder().encode(observerTokens(dir).join("\n")));
}

/** What `observerBuild` hashes: one line of tokens per source. */
export function observerTokens(dir = observerDir()): string[] {
  return OBSERVER_SOURCES.map(({ file, functions }) => {
    const source = ts.createSourceFile(
      file,
      readFileSync(join(dir, file), "utf8"),
      ts.ScriptTarget.Latest
    );
    const nodes = functions ? declared(source, functions) : [source];
    return `${file} ${nodes.map(tree).join(" ")}`;
  });
}

/** Each named function declaration, at any depth, in the order named. */
function declared(
  source: ts.SourceFile,
  names: readonly string[]
): ts.FunctionDeclaration[] {
  const found = new Map<string, ts.FunctionDeclaration>();
  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      names.includes(node.name.text)
    ) {
      if (found.has(node.name.text)) {
        throw new Error(
          `${source.fileName}: ${node.name.text} is declared twice`
        );
      }
      found.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names.map((name) => {
    const node = found.get(name);
    if (!node) throw new Error(`${source.fileName}: no function ${name}`);
    return node;
  });
}

/** `node` as nested kinds, names and literals, without parentheses. */
function tree(node: ts.Node): string {
  const out: string[] = [];
  const visit = (at: ts.Node) => {
    if (ts.isParenthesizedExpression(at)) return visit(at.expression);
    if (ts.isParenthesizedTypeNode(at)) return visit(at.type);
    out.push(ts.SyntaxKind[at.kind] ?? String(at.kind));
    if (ts.isIdentifier(at) || ts.isPrivateIdentifier(at)) out.push(at.text);
    else if (
      ts.isStringLiteral(at) ||
      ts.isNumericLiteral(at) ||
      ts.isBigIntLiteral(at) ||
      ts.isRegularExpressionLiteral(at) ||
      ts.isNoSubstitutionTemplateLiteral(at) ||
      ts.isTemplateHead(at) ||
      ts.isTemplateMiddle(at) ||
      ts.isTemplateTail(at)
    ) {
      out.push(JSON.stringify(at.text));
    }
    if (ts.isPrefixUnaryExpression(at) || ts.isPostfixUnaryExpression(at)) {
      out.push(ts.SyntaxKind[at.operator]);
    }
    if (ts.isVariableDeclarationList(at)) {
      out.push(String(at.flags & ts.NodeFlags.BlockScoped));
    }
    out.push("(");
    ts.forEachChild(at, visit);
    out.push(")");
  };
  visit(node);
  return out.join(" ");
}
