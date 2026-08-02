// ════════════════════════════════════════
// `must-consume-outcome` — the lint half of PHASE-4 T1.
//
// ── WHAT IT REFUSES ──
// A call that returns an `Outcome` (`packages/shared/src/outcome.ts`) whose value
// nobody looks at. Two discard shapes, because the second is how a discard hides
// from the first:
//
//   1. STATEMENT DISCARD   transition(id, {...});            // and `await`/`void` of it
//   2. WRITE-ONLY BINDING  const r = transition(id, {...});  // `r` never read
//
// Both are the same defect: a boundary reported a refusal and the caller carried on
// as if it had applied. That is the exact shape of "it said it sent the message and
// nothing arrived", moved one layer up.
//
// ── HOW IT RECOGNISES AN OUTCOME: BY SHAPE, NEVER BY NAME ──
// The type is matched structurally — every constituent of the (possibly union)
// return type must carry a `kind` property whose type is a string LITERAL drawn
// from the five `OUTCOME_KINDS`, and at least one constituent must be a
// non-`applied` arm (an outcome that can only ever say "applied" reports nothing
// and is not worth a lint).
//
// Name-matching was considered and refused: `WorkOutcome`, `ToolOutcome` and
// `DeliveryOutcome` are three different alias names over the same shape, aliases
// disappear through `Promise<T>` and generics, and a rename would silently switch
// the rule off. A shape cannot be renamed away — it can only be changed, and
// changing it means changing `OUTCOME_KINDS`, which this file reads rather than
// re-types (see KINDS below and the conformance clause in check-must-consume.mjs).
//
// ── WHAT IT DOES NOT REFUSE ──
// Passing the outcome on, returning it, storing it somewhere later read, branching
// on it, destructuring it, logging a field of it. Consumption is "something reads
// the value", not "something handles every arm" — a rule that demanded exhaustive
// handling would be a rule people route around, and the routing-around is the
// whitelist this project is trying not to grow.
//
// There is deliberately NO escape hatch (no `void x`, no `/* eslint-disable */`
// that survives — the checker runs with `--no-inline-config`). A site that truly
// does not care about a refusal is a site that should not be calling a boundary
// that can refuse.
// ════════════════════════════════════════

'use strict';

const ts = require('typescript');

/** The five arms. Kept in sync with packages/shared/src/outcome.ts by a
 *  conformance clause in check-must-consume.mjs, which reads BOTH lists and
 *  refuses when they differ. */
const KINDS = new Set(['applied', 'no_change', 'refused', 'failed', 'unknown']);

/** Arms that carry news. A type that can only say `applied` is not an Outcome
 *  worth consuming — it is a success. */
const REPORTING_KINDS = new Set(['no_change', 'refused', 'failed', 'unknown']);

/** Unwrap `Promise<T>` / `T | undefined` etc. down to the constituents worth testing. */
function constituents(type, checker) {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    if (!t || seen.has(t)) return;
    seen.add(t);
    if (t.isUnion && t.isUnion()) {
      for (const c of t.types) push(c);
      return;
    }
    // Promise<T> (and any thenable with a single type argument): look through it.
    const sym = t.getSymbol && t.getSymbol();
    if (sym && sym.getName() === 'Promise') {
      const args = checker.getTypeArguments ? checker.getTypeArguments(t) : (t.typeArguments || []);
      if (args && args.length === 1) { push(args[0]); return; }
    }
    out.push(t);
  };
  push(type);
  return out;
}

/** The `kind` literal of one constituent, or null when it has none. */
function kindOf(type, checker) {
  const prop = type.getProperty && type.getProperty('kind');
  if (!prop) return null;
  const decl = prop.valueDeclaration || (prop.declarations && prop.declarations[0]);
  const kt = decl
    ? checker.getTypeOfSymbolAtLocation(prop, decl)
    : (checker.getTypeOfSymbol ? checker.getTypeOfSymbol(prop) : null);
  if (!kt) return null;
  if (!(kt.flags & ts.TypeFlags.StringLiteral)) return null;
  return kt.value;
}

/**
 * Is this an Outcome-shaped type?
 *
 * Every constituent that is an object must carry an OUTCOME_KINDS `kind`, and the
 * union as a whole must be able to report something other than success. `null` and
 * `undefined` constituents are tolerated (`TransitionOutcome | null` is still an
 * outcome the caller must consume).
 */
function isOutcomeType(type, checker) {
  const parts = constituents(type, checker);
  if (parts.length === 0) return false;
  let objects = 0;
  let reporting = false;
  for (const p of parts) {
    if (p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) continue;
    const k = kindOf(p, checker);
    if (k === null || !KINDS.has(k)) return false;
    objects += 1;
    if (REPORTING_KINDS.has(k)) reporting = true;
  }
  return objects > 0 && reporting;
}

/** Peel `await x`, `void x`, `(x)`, `x as T`, `x!` down to the call underneath. */
function peel(node) {
  let n = node;
  for (;;) {
    if (!n) return n;
    if (n.type === 'AwaitExpression') { n = n.argument; continue; }
    if (n.type === 'UnaryExpression' && n.operator === 'void') { n = n.argument; continue; }
    if (n.type === 'TSAsExpression' || n.type === 'TSNonNullExpression' || n.type === 'TSSatisfiesExpression') {
      n = n.expression; continue;
    }
    if (n.type === 'SequenceExpression') { n = n.expressions[n.expressions.length - 1]; continue; }
    return n;
  }
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'An Outcome must be consumed. A discarded Outcome is a refusal that was reported and ignored.',
    },
    schema: [],
    messages: {
      discarded:
        'Discarded Outcome: `{{call}}` reports applied/no_change/refused/failed/unknown and nothing reads it. ' +
        'A refusal that nobody consumes is the defect PHASE-4 T1 exists to close — branch on `.kind`, or hand the value on.',
      writeOnly:
        'Write-only Outcome: `{{name}}` holds an Outcome that is never read. ' +
        'Binding a refusal to a name is not consuming it — read `.kind`, or hand the value on.',
    },
  },

  create(context) {
    const services = context.sourceCode.parserServices || context.parserServices;
    if (!services || !services.program || !services.esTreeNodeToTSNodeMap) {
      // Type information is the whole rule. Failing loudly beats reporting a
      // beautiful zero: check-must-consume.mjs treats this as a config bug.
      throw new Error('must-consume-outcome requires type-aware linting (parserOptions.project).');
    }
    const checker = services.program.getTypeChecker();

    const typeOf = (node) => {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      if (!tsNode) return null;
      return checker.getTypeAtLocation(tsNode);
    };

    const callText = (node) => {
      const src = context.sourceCode.getText(node);
      const oneLine = src.replace(/\s+/g, ' ').trim();
      return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
    };

    return {
      ExpressionStatement(node) {
        const inner = peel(node.expression);
        if (!inner || (inner.type !== 'CallExpression' && inner.type !== 'NewExpression')) return;
        // The type of the PEELED node, never the wrapper: `void f()` has type
        // `undefined`, so reading the wrapper is how `void` becomes a silent
        // escape hatch. It is not one — that is what the selftest's third
        // planted discard proves.
        const t = typeOf(inner);
        if (!t || !isOutcomeType(t, checker)) return;
        context.report({ node, messageId: 'discarded', data: { call: callText(inner.callee || inner) } });
      },

      VariableDeclarator(node) {
        if (!node.init || !node.id || node.id.type !== 'Identifier') return;
        const inner = peel(node.init);
        if (!inner || inner.type !== 'CallExpression') return;
        const t = typeOf(inner);
        if (!t || !isOutcomeType(t, checker)) return;
        const vars = context.sourceCode.getDeclaredVariables(node);
        for (const v of vars) {
          if (v.name !== node.id.name) continue;
          if (v.references.some((r) => r.isRead())) return;
        }
        context.report({ node: node.id, messageId: 'writeOnly', data: { name: node.id.name } });
      },
    };
  },
};
