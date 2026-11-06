import { loopError } from './errors.mjs'

export function candidatePreview(candidate) {
  const profile = candidate.kind === 'local' ? Object.values(candidate.profile.variants ?? {})[0] : candidate.definition
  return { id: candidate.id, name: candidate.name, description: candidate.description,
    source_name: candidate.source_name, kind: candidate.kind,
    license: candidate.license ?? profile?.source?.license ?? null,
    url: candidate.url ?? profile?.source?.url ?? null, instructions: profile?.instructions ?? '' }
}

// Search the complete enabled marketplace catalogs. Local installation is not a ranking signal.
export async function prepareGuidedPool(marketplace) {
  const candidates = [], warnings = [], sources = marketplace.sources().sources.filter(source => source.enabled)
  await Promise.all(sources.map(async source => {
    try {
      const result = await marketplace.catalog(source.id)
      for (const definition of result.definitions) candidates.push({
        id: 'market:' + source.id + ':' + definition.path, name: definition.name,
        description: definition.description ?? '', source_name: source.name, kind: 'market',
        source_id: source.id, path: definition.path, version: definition.version,
        digest: definition.digest, license: definition.license, url: definition.url,
        category: definition.category ?? '', tags: definition.tags ?? [],
      })
    } catch { warnings.push(source.name + ' 暂时不可用') }
  }))
  return { candidates, warnings, sources: sources.map(({ id, name }) => ({ id, name })) }
}

export function searchGuidedPool(pool, input) {
  const query = input.query?.trim()
  if (!query || query.length > 500) throw loopError('GUIDED_INPUT_INVALID', '请提供有效的 Agent 搜索词')
  const offset = input.offset ?? 0, limit = input.limit ?? 12
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 30) throw loopError('GUIDED_INPUT_INVALID', '搜索分页参数无效')
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}+#.-]+/gu) ?? [])]
  const ranked = pool.candidates.filter(row => !input.source_id || row.source_id === input.source_id).map(row => {
    const name = row.name.toLowerCase(), metadata = [row.category, ...row.tags].join(' ').toLowerCase(), description = row.description.toLowerCase()
    const score = terms.reduce((sum, term) => sum + (name.includes(term) ? 6 : metadata.includes(term) ? 3 : description.includes(term) ? 1 : 0), 0)
    return { ...row, score }
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return { query, total: ranked.length, offset, next_offset: offset + limit < ranked.length ? offset + limit : null,
    sources: pool.sources, warnings: pool.warnings, agents: ranked.slice(offset, offset + limit).map(({ id, name, description, source_name, source_id, category, tags, license }) => ({ id, name, description, source_name, source_id, category, tags, license })) }
}
