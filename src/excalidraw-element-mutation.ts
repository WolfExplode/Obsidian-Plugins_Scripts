/** The revision fields Excalidraw uses to recognize a changed element. */
export interface MutableSceneElement {
	id: string;
	version?: number;
	versionNonce?: number;
	updated?: number;
}

/** A target revision captured before asynchronous planning begins. */
export interface ElementRevision {
	id: string;
	version: number | undefined;
	versionNonce: number | undefined;
}

export interface ElementMutationAdapter<Element extends MutableSceneElement> {
	readElements(): readonly Element[];
	writeElements(elements: readonly Element[]): void;
}

export type ElementMutationResult =
	| { status: "applied"; changedIds: readonly string[] }
	| { status: "no-op" }
	| { status: "conflict"; conflictingIds: readonly string[] }
	| { status: "unavailable" }
	| { status: "failed"; error: unknown };

type RevisionFields = "id" | "version" | "versionNonce" | "updated";
export type ElementPatch<Element extends MutableSceneElement> = Partial<Omit<Element, RevisionFields>>;

/** A pseudo-random 31-bit integer for an element's versionNonce (mirrors Excalidraw). */
export function randomVersionNonce(): number {
	return Math.floor(Math.random() * 0x7fffffff);
}

/** Applies one patch with the revision fields Excalidraw requires. */
export function stampElementPatch<Element extends MutableSceneElement>(
	element: Element,
	patch: ElementPatch<Element>,
	versionNonce = randomVersionNonce(),
	updated = Date.now(),
): Element {
	return {
		...element,
		...patch,
		version: (element.version ?? 1) + 1,
		versionNonce,
		updated,
	};
}

export function captureElementRevisions(
	elements: readonly MutableSceneElement[],
): ElementRevision[] {
	return elements.map(({ id, version, versionNonce }) => ({ id, version, versionNonce }));
}

function conflictingElementRevisions<Element extends MutableSceneElement>(
	elements: readonly Element[],
	expected: readonly ElementRevision[],
): string[] {
	if (expected.length === 0) return [];
	const currentById = new Map(elements.map((element) => [element.id, element]));
	return expected.flatMap((revision) => {
		const current = currentById.get(revision.id);
		return !elementRevisionMatches(current, revision)
			? [revision.id]
			: [];
	});
}

export function elementRevisionMatches(
	element: MutableSceneElement | undefined,
	expected: { version?: number; versionNonce?: number },
): boolean {
	return !!element && element.version === expected.version && element.versionNonce === expected.versionNonce;
}

function patchChangesElement<Element extends MutableSceneElement>(
	element: Element,
	patch: ElementPatch<Element>,
): boolean {
	const current = element as Record<string, unknown>;
	return Object.entries(patch).some(([key, value]) => !Object.is(current[key], value));
}

/**
 * Commits one durable, undoable Excalidraw canvas element mutation.
 *
 * The caller owns feature planning and returns field patches. This module owns
 * the live re-read, optional optimistic revision check, identity-preserving
 * replacement, Excalidraw revision stamping, and the single durable write.
 */
export function commitElementMutation<Element extends MutableSceneElement>(
	adapter: ElementMutationAdapter<Element> | null,
	change: (element: Element) => ElementPatch<Element> | null,
	expected: readonly ElementRevision[] = [],
): ElementMutationResult {
	if (!adapter) return { status: "unavailable" };
	try {
		const elements = adapter.readElements();
		const conflictingIds = conflictingElementRevisions(elements, expected);
		if (conflictingIds.length > 0) return { status: "conflict", conflictingIds };

		const changedIds: string[] = [];
		const updated = Date.now();
		const nextElements = elements.map((element) => {
			const patch = change(element);
			if (!patch || !patchChangesElement(element, patch)) return element;
			changedIds.push(element.id);
			return stampElementPatch(element, patch, randomVersionNonce(), updated);
		});
		if (changedIds.length === 0) return { status: "no-op" };

		adapter.writeElements(nextElements);
		return { status: "applied", changedIds };
	} catch (error) {
		return { status: "failed", error };
	}
}
