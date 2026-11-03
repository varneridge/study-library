import { useCallback, useEffect, useRef, useState } from "react";
import { confirmAction } from "./ui";
import { setNavigationGuard } from "./router";

const identity = <T,>(v: T): T => v;

function shallowEqual<T extends Record<string, any>>(a: T, b: T): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export function useFormDraft<T extends Record<string, any>>(
  baseline: T,
  options?: {
    normalize?: (val: T) => T;
  }
) {
  const normalize = options?.normalize ?? identity;
  const [draft, setDraftState] = useState<T>(baseline);
  const [saving, setSaving] = useState(false);
  const [savedPatch, setSavedPatch] = useState<Partial<T>>({});

  const baselineRef = useRef<T>(baseline);
  const prevBaselinePropRef = useRef<T>(baseline);

  // Effective baseline incorporates any local saves that haven't yet arrived in baseline prop
  const effectiveBaseline = { ...baseline, ...savedPatch };

  // Rebase untouched fields when baseline prop changes from remote sync
  useEffect(() => {
    const prevProp = prevBaselinePropRef.current;
    if (shallowEqual(prevProp, baseline)) return;
    prevBaselinePropRef.current = baseline;
    baselineRef.current = baseline;

    setDraftState((currentDraft) => {
      const prevNorm = normalize(prevProp);
      const draftNorm = normalize(currentDraft);
      const nextNorm = normalize(baseline);
      let changed = false;
      const nextDraft = { ...currentDraft };

      for (const key of Object.keys(baseline) as (keyof T)[]) {
        // If untouched: normalized draft matches previous normalized baseline
        if (draftNorm[key] === prevNorm[key]) {
          if (nextDraft[key] !== baseline[key]) {
            nextDraft[key] = baseline[key];
            changed = true;
          }
        }
      }
      return changed ? nextDraft : currentDraft;
    });

    // Drop savedPatch on genuine baseline change as the store has updated
    setSavedPatch((c) => (Object.keys(c).length ? {} : c));
  }, [baseline, normalize]);

  const setField = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setDraftState((curr) => ({ ...curr, [key]: value }));
  }, []);

  const reset = useCallback(() => {
    setDraftState(baselineRef.current);
    setSavedPatch({});
  }, []);

  // Compute touched fields using normalized representations
  const normDraft = normalize(draft);
  const normBaseline = normalize(effectiveBaseline);
  const allKeys = Array.from(
    new Set([...Object.keys(normDraft), ...Object.keys(normBaseline)])
  ) as (keyof T)[];

  const touchedKeys = allKeys.filter((k) => normDraft[k] !== normBaseline[k]);
  const isDirty = touchedKeys.length > 0;

  const save = useCallback(
    async (performSave: (patch: Partial<T>) => Promise<void>): Promise<boolean> => {
      if (saving || !isDirty) return false;
      const snapshot = { ...draft };
      const currentNorm = normalize(snapshot);
      const currentBaselineNorm = normalize(effectiveBaseline);
      const currentTouched = Array.from(
        new Set([...Object.keys(currentNorm), ...Object.keys(currentBaselineNorm)])
      ).filter((k) => currentNorm[k] !== currentBaselineNorm[k]) as (keyof T)[];

      if (currentTouched.length === 0) return true;

      const patch: Partial<T> = {};
      for (const k of currentTouched) {
        patch[k] = snapshot[k];
      }

      setSaving(true);
      try {
        await performSave(patch);
        setSavedPatch((curr) => ({ ...curr, ...patch }));
        return true;
      } finally {
        setSaving(false);
      }
    },
    [draft, isDirty, saving, normalize, effectiveBaseline]
  );

  return {
    draft,
    setField,
    setDraftState,
    reset,
    isDirty,
    saving,
    save,
    touchedKeys,
  };
}

export function useUnsavedChangesGuard(isDirty: boolean, label = "form") {
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  const promptOpenRef = useRef(false);
  const unregisterRef = useRef<(() => void) | null>(null);

  const disarm = useCallback(() => {
    isDirtyRef.current = false;
    if (unregisterRef.current) {
      unregisterRef.current();
      unregisterRef.current = null;
    }
  }, []);

  const confirmDiscardIfDirty = useCallback(async (): Promise<boolean> => {
    if (!isDirtyRef.current) return true;
    if (promptOpenRef.current) return false;
    promptOpenRef.current = true;
    try {
      return await confirmAction({
        title: "Unsaved changes",
        body: `You have unsaved changes in this ${label}. If you leave now, your edits will be discarded.`,
        confirm: "Discard edits",
        danger: true,
      });
    } finally {
      promptOpenRef.current = false;
    }
  }, [label]);

  // Tab close / reload guard
  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  // Register guard with router
  useEffect(() => {
    if (!isDirty) return;
    unregisterRef.current = setNavigationGuard(confirmDiscardIfDirty);
    return () => {
      if (unregisterRef.current) {
        unregisterRef.current();
        unregisterRef.current = null;
      }
    };
  }, [isDirty, confirmDiscardIfDirty]);

  return { confirmDiscardIfDirty, disarm };
}
