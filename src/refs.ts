import { parseRef, type SessionRef } from "./runtime/types.ts";

/**
 * A ref as Dori stores and prints it: the bare hc terminal address (`t7`). roles.json values, inbox file names and
 * delivery notices use this form.
 */
export const refText = (ref: SessionRef): string => ref.id;

/** Reads refText back (`hc:t7` is read too). A stored value that is no address is kept as the id it names. */
export const refFromText = (text: string): SessionRef => parseRef(text) ?? { runtime: "hc", id: text };

export const sameSession = (a: SessionRef, b: SessionRef): boolean => a.runtime === b.runtime && a.id === b.id;
