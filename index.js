/**
 * Host half of `@local/dsh-copy-markdown`.
 *
 * The work happens in the browser: a capture-phase `copy` listener plus a
 * `markdownSource` client service. The Host half only exists so the bundle has
 * a row in the composition (which is what makes the Web shell's client roster
 * pick up `./client`).
 */
export function apply() {}
