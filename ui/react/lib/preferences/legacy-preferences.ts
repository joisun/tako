// Read old browser keys once; all active preference writers use the TAKO prefix.
export function migrateLegacyPreferences(storage: Storage = window.localStorage) {
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => key !== null)
    const priority = (key: string) => /^undercontrol[.:-]/i.test(key) ? 0 : /^rillo[.:-]/i.test(key) ? 1 : 2
    keys.sort((left, right) => priority(left) - priority(right))
    for (const key of keys) {
      if (!/^(?:undercontrol|rillo|tasks?[-_]recorder)[.:-]/i.test(key)) continue
      const next = key.replace(/^(?:undercontrol|rillo|tasks?[-_]recorder)/i, 'tako')
      const value = storage.getItem(key)
      if (value !== null && storage.getItem(next) === null) storage.setItem(next, value)
      storage.removeItem(key)
    }
  } catch { /* Storage may be blocked; keep existing values instead of failing startup. */ }
}
