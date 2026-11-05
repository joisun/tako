// Read old browser keys once; all active preference writers use the UnderControl prefix.
export function migrateLegacyPreferences(storage: Storage = window.localStorage) {
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => key !== null)
    for (const key of keys) {
      if (!/^(?:rillo|tasks?[-_]recorder)[.:-]/i.test(key)) continue
      const next = key.replace(/^(?:rillo|tasks?[-_]recorder)/i, 'undercontrol')
      const value = storage.getItem(key)
      if (value !== null && storage.getItem(next) === null) storage.setItem(next, value)
      storage.removeItem(key)
    }
  } catch { /* Storage may be blocked; keep existing values instead of failing startup. */ }
}
