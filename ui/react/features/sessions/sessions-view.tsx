import { m } from 'motion/react'
import { transition } from '@/lib/motion'
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Folder, FolderOpen, GitBranch, MessagesSquare, PanelRightOpen, Pin, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { SegmentedControl } from '@/components/ui/segmented-control'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { BrowserSession, SessionBranchPage, SessionPage, SessionRef, SessionWorkspacePage } from '@/lib/api/types'
import { queryKeys } from '@/lib/query/keys'
import { persistSessionsGroup, readSessionsGroup, type SessionGroupMode } from '@/lib/preferences/dashboard-preferences'
import { SessionDetail } from './session-detail'
import { AutoPager } from './session-auto-pager'
import { isSessionBlockingError, useSessionConnectionError } from './session-health'
import { SessionAncestorSource } from './session-children'
import { collectSessionFamily, indexSessionRelations, projectSessionTree } from './session-projection'
import { SessionSearch } from './session-search'
import { SessionOrigin } from './session-origin'
import { sessionKey } from './session-format'
import { SessionPinButton, useSessionPins } from './session-pins'
import { sessionReadRequests } from './session-timeline-queue'
import { SessionSummary } from './session-summary'
import { SessionActivity } from './session-activity'
import { SessionActivityView } from './session-activity-view'
import './sessions.css'
import { compareSessions, sessionStatusGroup, sessionStatusOptions, sessionWithStatus, SessionStatusGroup } from './session-status'

function useRevealSearchHit(hit: BrowserSession | null, pending: boolean) {
  return useCallback((row: HTMLElement | null) => {
    if (!row || !hit || pending) return
    const frame = requestAnimationFrame(() => {
      const panel = row.closest<HTMLElement>('[data-session-scroll]')
      if (!panel?.clientHeight) return
      // Motion can still be translating a reordered row. Read its final layout position.
      let top = 0
      for (let el: HTMLElement | null = row; el && el !== panel; el = el.offsetParent as HTMLElement | null) top += el.offsetTop
      if (top < panel.scrollTop || top + row.offsetHeight > panel.scrollTop + panel.clientHeight) {
        panel.scrollTop = top - Math.max(0, (panel.clientHeight - row.offsetHeight) / 2)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [hit, pending])
}

export function SessionsView({ api }: { api: DashboardApi }) {
  const client = useQueryClient()
  const connectionError = useSessionConnectionError()
  const reconnect = () => client.refetchQueries({ queryKey: queryKeys.sessionBrowser, type: 'active', predicate: query => isSessionBlockingError(query.queryKey, query.state.error) && query.state.fetchStatus === 'idle' }, { cancelRefetch: false })
  useEffect(() => {
    if (!connectionError) return
    const timer = window.setInterval(() => void reconnect(), 3000)
    return () => window.clearInterval(timer)
  }, [connectionError, client])
  const [statusSort, setStatusSort] = useState<SessionStatusGroup | null>(null)
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [pinnedLayout, setPinnedLayout] = useState(() => localStorage.getItem('tako.pinned-layout') === 'cards' ? 'cards' : 'list')
  const pins = useSessionPins(api)
  const pinnedKeys = useMemo(() => new Set((pins.data?.pins ?? []).map(sessionKey)), [pins.data])
  const [childPages, setChildPages] = useState<Record<string, SessionPage[]>>({})
  const rememberChildren = useCallback((key: string, pages: SessionPage[]) => setChildPages(current => current[key] === pages ? current : { ...current, [key]: pages }), [])
  const [sourceId, setSourceId] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [branch, setBranch] = useState('')
  const [groupPreference, setGroupPreference] = useState(readSessionsGroup)
  const [directoryQuery, setDirectoryQuery] = useState('')
  const [catalogPickerOpen, setCatalogPickerOpen] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const [searchHit, setSearchHit] = useState<BrowserSession | null>(null)
  const [selection, setSelection] = useState<{ session: BrowserSession; query: string; at: string | null; fromSearch?: boolean; itemId?: string; followRequest?: number } | null>(null)
  const followRequestSequence = useRef(0)
  const [readerOpen, setReaderOpen] = useState(false)
  const [readerHost, setReaderHost] = useState<HTMLDivElement | null>(null)
  const readerPopup = useRef<HTMLDivElement>(null)
  const [ancestors, setAncestors] = useState<Record<string, BrowserSession>>({})
  const [unavailableAncestors, setUnavailableAncestors] = useState<Set<string>>(() => new Set())
  const ancestorUnavailable = useCallback((key: string) => setUnavailableAncestors(current => current.has(key) ? current : new Set([...current, key])), [])
  const rememberAncestor = useCallback((session: BrowserSession) => setAncestors(current => current[sessionKey(session)] === session ? current : { ...current, [sessionKey(session)]: session }), [])
  const [readError, setReadError] = useState('')
  const [reading, setReading] = useState(false)
  const readRequest = useRef<AbortController | null>(null)
  useEffect(() => {
    const url = new URL(window.location.href)
    url.searchParams.delete('sessions')
    window.localStorage.removeItem('tako.sessions-view')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])
  useEffect(() => persistSessionsGroup(groupPreference), [groupPreference])
  useEffect(() => () => readRequest.current?.abort(), [])
  const providers = useQuery({ queryKey: queryKeys.sessionProviders, queryFn: () => api.sessionProviders(), retry: false })
  const provider = providers.data?.providers.find((item) => item.id === sourceId) ?? providers.data?.providers[0]
  const providerId = provider?.id ?? ''
  const groupMode = groupPreference === 'branch' && provider?.capabilities.branch_groups ? 'branch' : 'workspace'
  const isBranch = groupMode === 'branch'
  const scope = isBranch ? branch : workspace
  const activity = useQuery({
    queryKey: queryKeys.sessionActivity(providerId, provider?.store_id ?? ''),
    queryFn: () => api.sessionActivity(providerId),
    enabled: Boolean(provider?.capabilities.live_presence),
    refetchInterval: 5000, retry: false, gcTime: 0,
  })
  const nativeActivity = !activity.isError && activity.data?.store_id === provider?.store_id ? activity.data : undefined
  const nativeStatuses = useMemo(() => new Map((nativeActivity?.sessions ?? []).map(session => [sessionKey(session), session])), [nativeActivity?.sessions])
  const withStatus = (session: BrowserSession) => sessionWithStatus(session, nativeActivity, nativeStatuses)
  const directories = useInfiniteQuery({
    queryKey: queryKeys.sessionWorkspaces(providerId, false),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.sessionWorkspaces(providerId, { cursor: pageParam }),
    getNextPageParam: (page: SessionWorkspacePage) => page.next_cursor ?? undefined,
    enabled: Boolean(provider) && !isBranch,
    retry: false,
    staleTime: 3000, refetchInterval: 15_000, refetchOnWindowFocus: true,
  })
  const branches = useInfiniteQuery({
    queryKey: queryKeys.sessionBranches(providerId, false),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.sessionBranches(providerId, { cursor: pageParam }),
    getNextPageParam: (page: SessionBranchPage) => page.next_cursor ?? undefined,
    enabled: Boolean(provider) && isBranch, retry: false,
    staleTime: 3000, refetchInterval: 15_000, refetchOnWindowFocus: true,
  })
  const catalog = isBranch ? branches : directories
  const results = useInfiniteQuery({
    queryKey: pinnedOnly ? queryKeys.sessionPinnedList(providerId, provider?.store_id ?? '', workspace, branch) : queryKeys.sessionList(providerId, workspace, '', false, branch),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => pinnedOnly
      ? api.pinnedSessions(providerId, { store_id: provider?.store_id, workspace, branch, cursor: pageParam, limit: 30 })
      : api.sessions(providerId, { workspace, branch, cursor: pageParam, limit: 100 }),
    getNextPageParam: (page: SessionPage) => page.next_cursor ?? undefined,
    enabled: Boolean(provider),
    retry: false,
    gcTime: 60_000,
    staleTime: 3000, refetchInterval: 15_000, refetchOnWindowFocus: true,
  })
  const listedHit = searchHit && (!pinnedOnly || pinnedKeys.has(sessionKey(searchHit))) ? searchHit : null
  const revealHit = selection?.fromSearch ? listedHit : null
  const revealDirectory = useRevealSearchHit(revealHit, catalog.isPending)
  const revealRow = useRevealSearchHit(revealHit, results.isPending)
  const [hitRelations] = useQueries({ queries: (listedHit ? [listedHit] : []).map(hit => ({
    queryKey: queryKeys.sessionRelations(hit), queryFn: () => api.sessionRelations(hit), retry: false,
  })) })
  const rootSessions = useMemo(() => {
    const rows = (results.data?.pages ?? []).flatMap(page => page.sessions)
    if (listedHit) rows.unshift(listedHit)
    return [...new Map(rows.map(session => [sessionKey(session), sessionWithStatus(session, nativeActivity, nativeStatuses)])).values()]
      .sort((left, right) => compareSessions(left, right, statusSort))
  }, [listedHit, results.data, nativeActivity?.available, nativeActivity?.store_id, nativeStatuses, workspace, branch, statusSort])
  const baseRelations = useMemo(() => [...(hitRelations?.data?.relations ?? []), ...(results.data?.pages ?? []).flatMap(page => page.relations)], [results.data, hitRelations?.data])
  const family = useMemo(() => collectSessionFamily(rootSessions, baseRelations, childPages, ancestors), [rootSessions, baseRelations, childPages, ancestors])
  const relations = family.relations
  const sessions = useMemo(() => family.sessions.map(session => sessionWithStatus(session, nativeActivity, nativeStatuses))
    .sort((left, right) => compareSessions(left, right, statusSort)), [family.sessions, nativeActivity?.available, nativeActivity?.store_id, nativeStatuses, statusSort])
  const relationIndex = useMemo(() => indexSessionRelations(relations), [relations])
  const knownSessions = useMemo(() => new Map([...(selection ? [selection.session] : []), ...sessions].map(session => [sessionKey(session), session])), [sessions, selection?.session])
  const activeSessions = (nativeActivity?.sessions ?? []).filter(session => session.state === 'active')
  const activeWorkspaces = new Set(activeSessions.map(session => session.workspace))
  const displayedSessions = useMemo(() => {
    const pending = projectSessionTree(sessions, relations)
    const displayed: BrowserSession[] = []
    while (pending.length) {
      const node = pending.shift()!
      if (node.session) displayed.push(node.session)
      pending.push(...node.children)
    }
    return displayed
  }, [sessions, relations])
  const statusCounts = new Map(sessionStatusOptions.map(option => [option.id, displayedSessions.filter(session => sessionStatusGroup(session) === option.id).length]))
  useEffect(() => {
    if ((directoryQuery || catalogPickerOpen) && catalog.hasNextPage && !catalog.isFetching && !catalog.isError) void catalog.fetchNextPage()
  }, [directoryQuery, catalogPickerOpen, catalog.hasNextPage, catalog.isFetching, catalog.isError, catalog.fetchNextPage])
  useEffect(() => {
    if (branch && !sessions.length && results.hasNextPage && !results.isFetching && !results.isError) void results.fetchNextPage()
  }, [branch, sessions.length, results.hasNextPage, results.isFetching, results.isError, results.fetchNextPage])
  const groups = useMemo(() => {
    if (isBranch) {
      const byName = new Map<string, { name: string; ids: Set<string>; paths: Set<string>; latest: string }>()
      for (const group of (branches.data?.pages ?? []).flatMap(page => page.branches)) {
        const merged = byName.get(group.name) ?? { name: group.name, ids: new Set<string>(), paths: new Set<string>(), latest: '' }
        for (const id of group.session_ids) merged.ids.add(id)
        for (const path of group.workspace_paths) merged.paths.add(path)
        if ((group.last_active_at ?? '') > merged.latest) merged.latest = group.last_active_at ?? ''
        byName.set(group.name, merged)
      }
      if (searchHit?.branch) {
        const group = byName.get(searchHit.branch) ?? { name: searchHit.branch, ids: new Set<string>(), paths: new Set<string>(), latest: searchHit.last_active_at ?? '' }
        group.ids.add(searchHit.session_id)
        if (searchHit.workspace) group.paths.add(searchHit.workspace)
        byName.set(group.name, group)
      }
      return [...byName.values()].sort((left, right) => right.latest.localeCompare(left.latest))
        .filter(group => group.name.toLocaleLowerCase().includes(directoryQuery.toLocaleLowerCase()))
        .map(group => ({ key: group.name, label: group.name, children: [...group.paths], count: group.ids.size, active: activeSessions.some(session => session.branch === group.name) }))
    }
    const byPath = new Map<string, { path: string; count: number; branches: Set<string>; latest: string }>()
    for (const group of (directories.data?.pages ?? []).flatMap((page) => page.workspaces)) {
      const previous = byPath.get(group.path)
      const latest = group.last_active_at ?? ''
      byPath.set(group.path, { path: group.path, count: (previous?.count ?? 0) + group.observed_count, branches: new Set([...(previous?.branches ?? []), ...(group.branch_names ?? [])]), latest: previous && previous.latest > latest ? previous.latest : latest })
    }
    if (searchHit?.workspace) {
      const group = byPath.get(searchHit.workspace) ?? { path: searchHit.workspace, count: 1, branches: new Set<string>(), latest: searchHit.last_active_at ?? '' }
      if (searchHit.branch) group.branches.add(searchHit.branch)
      byPath.set(group.path, group)
    }
    return [...byPath.values()].sort((left, right) => right.latest.localeCompare(left.latest))
      .filter((group) => group.path.toLocaleLowerCase().includes(directoryQuery.toLocaleLowerCase()))
      .map(group => ({ key: group.path, label: group.path, children: [...group.branches].sort(), count: group.count, active: activeWorkspaces.has(group.path) }))
  }, [isBranch, branches.data, directories.data, directoryQuery, nativeActivity, searchHit])
  const pickerItems = groups.flatMap(group => [
    { key: group.key, label: group.label, parent: group.label, branch: isBranch ? group.key : '', path: isBranch ? '' : group.key, child: false, isPath: !isBranch },
    ...group.children.map(child => ({ key: JSON.stringify(isBranch ? [group.key, child] : [child, group.key]), label: child, parent: group.label, branch: isBranch ? group.key : child, path: isBranch ? child : group.key, child: true, isPath: isBranch })),
  ])
  const pickerScope = branch && workspace ? JSON.stringify([branch, workspace]) : scope

  function chooseWorkspace(path: string) {
    readRequest.current?.abort()
    setReading(false)
    setReadError('')
    setWorkspace(path)
    setBranch('')
    setSearchHit(null)
    setSelection(null)
    setReaderOpen(false)
  }

  function chooseScope(value: string, child = '') {
    chooseWorkspace(isBranch ? child : value)
    setBranch(isBranch ? value : child)
  }

  function toggleGroup(key: string) {
    setCollapsedGroups(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function chooseGrouping(value: SessionGroupMode) {
    setCollapsedGroups(current => {
      const next = new Set(current)
      next.delete(`${value}:${value === 'workspace' ? workspace : branch}`)
      return next
    })
    setDirectoryQuery('')
    setGroupPreference(value)
  }

  function changeReaderOpen(open: boolean) {
    if (!open) { readRequest.current?.abort(); setReading(false) }
    setReaderOpen(open)
  }

  function selectSearchHit(session: BrowserSession, query: string) {
    const path = session.workspace ?? ''
    const name = session.branch ?? ''
    let mode: SessionGroupMode = groupMode
    if (isBranch && !name && path) mode = 'workspace'
    if (!isBranch && !path && name && provider?.capabilities.branch_groups) mode = 'branch'
    setGroupPreference(mode)
    setWorkspace(path)
    setBranch(name)
    setDirectoryQuery('')
    setCollapsedGroups(current => {
      const next = new Set(current)
      next.delete(`${mode}:${mode === 'branch' ? name : path}`)
      return next
    })
    if (!pinnedKeys.has(sessionKey(session))) setPinnedOnly(false)
    setSearchHit({ ...session })
    selectSession(session, query, true)
  }

  function selectSession(session: BrowserSession, query = '', fromSearch = false) {
    readRequest.current?.abort()
    setReading(false)
    setReadError('')
    setReaderOpen(true)
    setSelection({ session, query, fromSearch, at: null, followRequest: ++followRequestSequence.current })
  }

  async function selectLatest(session: BrowserSession) {
    readRequest.current?.abort()
    const controller = new AbortController()
    readRequest.current = controller
    setReading(true)
    setReadError('')
    try {
      const page = await sessionReadRequests.run(() => api.sessionTimeline(session, {}, controller.signal), controller.signal)
      if (controller.signal.aborted) return
      client.setQueryData(queryKeys.sessionTimeline(session, 'session', session.updated_at ?? ''), { pages: [page], pageParams: [null] })
      const latest = page.bounds?.end_at ?? page.points?.at(-1)?.at ?? null
      setReaderOpen(true)
      setSelection({ session, query: '', at: latest, itemId: page.points?.find(point => point.at === latest)?.item_id, followRequest: ++followRequestSequence.current })
    } catch (error) {
      if (!controller.signal.aborted) setReadError(error instanceof Error ? error.message : String(error))
    } finally { if (!controller.signal.aborted) setReading(false) }
  }

  async function onReadSession(ref: SessionRef) {
    readRequest.current?.abort()
    const controller = new AbortController()
    readRequest.current = controller
    setReading(true)
    setReadError('')
    try {
      const result = await api.readSession(ref, controller.signal)
      if (!controller.signal.aborted) { setSelection({ session: result.session, query: '', at: null }); setReaderOpen(true) }
    } catch (error) {
      if (!controller.signal.aborted) setReadError(`会话不可用：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (!controller.signal.aborted) setReading(false)
    }
  }

  return (
    <div className="sessions-workspace" data-detail-open={Boolean(selection && readerOpen)}>
      {family.missingParents.map(reference => <SessionAncestorSource key={sessionKey(reference)} api={api} reference={reference} onData={rememberAncestor} onUnavailable={ancestorUnavailable} />)}
      <header className="sessions-toolbar" inert={Boolean(connectionError)}>
        <div className="sessions-toolbar__search">
          <SessionSearch key={providerId} api={api} provider={providerId} storeId={provider?.store_id ?? ''}
            enabled={Boolean(provider?.capabilities.full_text_search)} activity={nativeActivity} statuses={nativeStatuses}
            onSelect={selectSearchHit} />
        </div>
        <div className="sessions-toolbar__controls">
        <Select className="session-group-picker" aria-label="侧栏分组" value={groupMode} onValueChange={key => chooseGrouping(key === 'branch' ? 'branch' : 'workspace')}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="workspace">Workspace</SelectItem><SelectItem value="branch" disabled={!provider?.capabilities.branch_groups}>Branch</SelectItem></SelectContent></Select>
        <Select className="session-workspace-picker" aria-label={isBranch ? '筛选 Branch' : '筛选 Workspace'} value={pickerScope || '__all__'} onOpenChange={setCatalogPickerOpen} onValueChange={(key) => { const item = pickerItems.find(item => item.key === key); chooseScope(isBranch ? item?.branch ?? '' : item?.path ?? '', isBranch ? item?.path : item?.branch) }}><SelectTrigger size="sm" aria-label={isBranch ? '筛选 Branch' : '筛选 Workspace'}><SelectValue>{workspace ? <span className="session-path" title={`${branch}\n${workspace}`}><bdi dir="ltr">{workspace}</bdi></span> : undefined}</SelectValue></SelectTrigger><SelectContent className="session-scope-options"><SelectItem value="__all__">{isBranch ? '全部分支' : '全部项目'}</SelectItem>{pickerItems.map(item => <SelectItem value={item.key} key={item.key} aria-label={item.child ? `${item.parent} · ${item.label}` : item.label} className={item.child ? 'session-scope-child' : undefined}><span className={item.isPath ? 'session-path' : undefined} title={item.label}><bdi dir="ltr">{item.label}</bdi></span></SelectItem>)}</SelectContent></Select>
          {(providers.data?.providers.length ?? 0) > 1 ? (
            <Select aria-label="会话来源" value={providerId} onValueChange={(key) => { setSourceId(String(key)); chooseWorkspace('') }}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent>{providers.data?.providers.map((item) => <SelectItem value={item.id} key={item.id}>{item.name}</SelectItem>)}</SelectContent></Select>
          ) : provider?.name ? <span className="session-source">{provider.name}</span> : null}
          <Button aria-label="刷新会话" isIconOnly size="xs" variant="quiet" disabled={!provider || results.isFetching || catalog.isFetching} onClick={() => { void Promise.all([results.refetch(), catalog.refetch(), activity.refetch(), client.invalidateQueries({ queryKey: queryKeys.sessionBrowser, predicate: (query) => ['timeline', 'children', 'relations', 'read'].some((key) => query.queryKey.includes(key)) })]) }}><RefreshCw /></Button>
        </div>
      </header>
      {connectionError ? <div className="sessions-connection" role="alert"><MessagesSquare /><strong>暂时无法连接本机会话</strong><span>正在自动重连</span><Button size="sm" variant="secondary" onClick={() => void reconnect()}>立即重试</Button></div> : null}
      {readError ? <p className="session-error" role="alert">{readError}</p> : null}
      {pins.isError ? <p className="session-error" role="alert">无法读取 Pin 标记：{pins.error.message}</p> : null}
      {pinnedOnly && results.isError ? <p className="session-error" role="alert">无法读取 Pinned 会话：{results.error.message}</p> : null}
      {!providers.isPending && !provider ? <div className="session-state">没有已接入的会话来源</div> : null}
      <div className="sessions-layout" inert={Boolean(connectionError)} aria-busy={reading || undefined}>
        <aside className="session-workspaces" aria-label={isBranch ? '分支分组' : '项目目录'}>
          <div className="session-workspaces__heading"><SegmentedControl className="session-group-switch" label="侧栏分组" value={groupMode} onValueChange={chooseGrouping} options={[{ value: 'workspace', label: <><Folder />Workspace</> }, { value: 'branch', label: <><GitBranch />Branch</>, disabled: !provider?.capabilities.branch_groups }]} /><Input aria-label={isBranch ? '筛选分支名称' : '筛选项目目录'} placeholder={isBranch ? '筛选分支…' : '筛选目录…'} size="sm" value={directoryQuery} onChange={(event) => setDirectoryQuery(event.currentTarget.value)} /></div>
          <button type="button" className="session-directory" aria-pressed={!scope} onClick={() => chooseScope('')}>{isBranch ? <GitBranch /> : <FolderOpen />}<span><strong>{isBranch ? '全部分支' : '全部项目'}</strong></span></button>
          <div className="session-workspaces__list" data-session-scroll key={groupMode}>
            <ul className="session-directory-tree" aria-label={isBranch ? '分支目录' : 'Workspace'}>
              {groups.map(group => {
                const key = `${groupMode}:${group.key}`
                const collapsed = collapsedGroups.has(key)
                const childScope = isBranch ? workspace : branch
                const childrenLabel = isBranch ? '项目目录' : '分支'
                return <li key={group.key}>
                <div className="session-directory-tree__heading" data-selected={scope === group.key || undefined}>
                  {group.children.length ? <button type="button" className="session-directory-tree__toggle" aria-label={`${collapsed ? '展开' : '折叠'}${isBranch ? '分支目录' : '项目分支'}`} aria-expanded={!collapsed} onClick={() => toggleGroup(key)}>{collapsed ? <ChevronRight /> : <ChevronDown />}</button> : null}
                  <button type="button" className="session-directory" ref={scope === group.key && !childScope ? revealDirectory : undefined} aria-pressed={scope === group.key && !childScope} onClick={() => chooseScope(group.key)}>
                    {isBranch ? <GitBranch /> : <Folder />}<span title={group.label}><strong className={isBranch ? undefined : 'session-path'}><bdi dir="ltr">{group.label}</bdi></strong></span>{group.active ? <span className="session-directory__active" role="img" aria-label={isBranch ? '分支活跃' : '项目活跃'} /> : null}<span className="session-directory__count" title={`${group.count} 个已载入会话`}>{group.count}</span>
                  </button>
                </div>
                {group.children.length ? <m.ul className="session-directory-tree__children" aria-label={`${group.label} ${childrenLabel}`} inert={collapsed} aria-hidden={collapsed} initial={false} animate={{ height: collapsed ? 0 : 'auto', opacity: collapsed ? 0 : 1 }} transition={revealHit && group.key === scope && !collapsed ? { duration: 0 } : transition.standard} style={{ overflow: 'hidden' }}>
                  {group.children.map(child => <li key={child}><button type="button" className="session-directory" ref={scope === group.key && childScope === child ? revealDirectory : undefined} aria-pressed={scope === group.key && childScope === child} onClick={() => chooseScope(group.key, child)}>
                    {isBranch ? <Folder /> : <GitBranch />}<span title={child}><strong className={isBranch ? 'session-path' : undefined}><bdi dir="ltr">{child}</bdi></strong></span>{activeSessions.some(session => session.workspace === (isBranch ? child : group.key) && session.branch === (isBranch ? group.key : child)) ? <span className="session-directory__active" role="img" aria-label="项目活跃" /> : null}
                  </button></li>)}
                </m.ul> : null}
              </li>})}
            </ul>
            <AutoPager enabled={Boolean(catalog.hasNextPage) && !catalog.isError} loading={catalog.isFetching} onMore={() => catalog.fetchNextPage()} />
          </div>
        </aside>
        <div className="sessions-main">
          <header className="sessions-main__toolbar">
            <div className="session-status-sort" role="group" aria-label="会话状态排序">
              <button type="button" aria-pressed={pinnedOnly} aria-label={`Pinned ${(pins.data?.pins ?? []).filter(pin => pin.provider === providerId && pin.store_id === provider?.store_id).length}`} title="仅查看已标记会话，再次点击查看全部" disabled={!pins.data} onClick={() => setPinnedOnly(current => !current)}><Pin aria-hidden="true" />Pinned<span className="session-status-sort__count">{(pins.data?.pins ?? []).filter(pin => pin.provider === providerId && pin.store_id === provider?.store_id).length}</span></button>
              {nativeActivity?.available ? sessionStatusOptions.map(option => <button type="button" key={option.id} data-status={option.id} aria-pressed={statusSort === option.id} aria-label={`${option.label} ${statusCounts.get(option.id) ?? 0}`} title={`${option.description}；点击优先排列，再次点击恢复最近消息排序。计数为当前范围已载入的会话。`} onClick={() => setStatusSort(current => current === option.id ? null : option.id)}><span className="session-status-sort__dot" aria-hidden="true" />{option.label}<span className="session-status-sort__count">{statusCounts.get(option.id) ?? 0}</span></button>) : <span className="session-status-sort__unavailable" role="status">{activity.isPending ? '读取状态…' : '状态不可用'}</span>}
            </div>
            {pinnedOnly && <SegmentedControl label="Pinned 视图" value={pinnedLayout}
              options={[{ value: 'list', label: '列表' }, { value: 'cards', label: '卡片' }]}
              onValueChange={layout => { setPinnedLayout(layout); localStorage.setItem('tako.pinned-layout', layout) }} />}
            <Button className="session-sheet-toggle" aria-label="展开会话面板" isIconOnly size="xs" variant="quiet" disabled={!selection || readerOpen} onClick={() => setReaderOpen(true)}><PanelRightOpen /></Button>
          </header>
          <section className="sessions-activity-panel">
          {pinnedOnly && pinnedLayout === 'cards' ? <div className="session-pinned-scroll" data-session-scroll>
            <div className="session-pinned-grid">{rootSessions.map(session => <article key={sessionKey(session)} className="session-pinned-card"
              data-selected={selection && sessionKey(selection.session) === sessionKey(session) || undefined}
              ref={revealHit && sessionKey(revealHit) === sessionKey(session) ? revealRow : undefined}>
              <header><SessionActivity session={session} /><button className="session-tree__title" onClick={() => selectSession(session)}>{session.title}</button>
                <SessionPinButton api={api} session={session} /></header>
              <SessionOrigin workspace={session.workspace} branch={session.branch} />
              <SessionSummary api={api} session={session} />
            </article>)}</div>
            {!rootSessions.length && !results.isFetching && !results.hasNextPage && !results.isError && <p className="session-state">当前范围没有已标记会话</p>}
            <AutoPager enabled={Boolean(results.hasNextPage) && !results.isError} loading={results.isFetching} onMore={() => results.fetchNextPage()} />
          </div> : <SessionActivityView revealHit={revealHit} revealRow={revealRow} pinnedOnly={pinnedOnly} pinnedKeys={pinnedKeys} canResume={Boolean(provider?.capabilities.resume)} key={`${providerId}:${workspace}:${branch}:${pinnedOnly}`} api={api} sessions={sessions} relations={relations} relationIndex={relationIndex} knownSessions={knownSessions} onChildren={rememberChildren} ancestorState={family.missingParents.length === 0 ? 'complete' : family.missingParents.some(ref => !unavailableAncestors.has(sessionKey(ref))) ? 'pending' : 'unavailable'} activity={nativeActivity} statuses={nativeStatuses} statusSort={statusSort} selection={selection?.session ?? null} hasMore={Boolean(results.hasNextPage) && !results.isError} loadingMore={results.isFetching} onMore={() => results.fetchNextPage()}
            onSelect={selectSession} onLatest={session => void selectLatest(session)} onReadSession={(ref) => void onReadSession(ref)} />}
          </section>
        </div>
      </div>
      <div className="session-reader-sheet-host" ref={setReaderHost}>
          {selection && readerHost ? <Sheet open={readerOpen} onOpenChange={changeReaderOpen} modal={false}><SheetContent ref={readerPopup} container={readerHost} keepMounted initialFocus={readerPopup} finalFocus={false} floating className="session-reader-sheet" aria-label="会话面板">
            <div className="session-reader-sheet__content"><SessionDetail canResume={Boolean(provider?.capabilities.resume)} key={sessionKey(selection.session)} api={api} session={withStatus(knownSessions.get(sessionKey(selection.session))??selection.session)} knownSessions={knownSessions} knownRelations={relations} query={selection.query} at={selection.at} itemId={selection.itemId} followRequest={selection.followRequest} onReadSession={(ref) => void onReadSession(ref)} onLoadTimeline={() => void client.invalidateQueries({ queryKey: queryKeys.sessionTimeline(selection.session, 'session', selection.session.updated_at ?? '') })} active={readerOpen} onSeek={(at, itemId) => setSelection(current => current ? { ...current, query: '', at, itemId, followRequest: ++followRequestSequence.current } : current)} onBack={() => changeReaderOpen(false)} /></div>
          </SheetContent></Sheet> : null}
      </div>
    </div>
  )
}
