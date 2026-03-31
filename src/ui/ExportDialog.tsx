import * as Dialog from '@radix-ui/react-dialog'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useTranslation } from 'react-i18next'
import { archiveConversation, deleteConversation, fetchAllConversations, fetchConversation, fetchConversationsPage, fetchProjects } from '../api'
import { EXPORT_OPERATION_BATCH } from '../constants'
import { exportAllToHtml } from '../exporter/html'
import { exportAllToJson, exportAllToOfficialJson } from '../exporter/json'
import { exportAllToMarkdown } from '../exporter/markdown'
import { RequestQueue } from '../utils/queue'
import { sleep } from '../utils/utils'
import { CheckBox } from './CheckBox'
import { IconCross, IconLoading, IconUpload } from './Icons'
import { useSettingContext } from './SettingContext'
import type { ApiConversationItem, ApiConversationWithId, ApiProjectInfo } from '../api'
import type { FC } from '../type'
import type { ChangeEvent } from 'preact/compat'

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Normalise create_time / update_time to milliseconds regardless of whether
 * the API returned an ISO 8601 string (current) or a Unix-seconds number (legacy).
 */
function toMs(time: number | string | undefined): number {
    if (time == null) return 0
    if (typeof time === 'number') return time * 1000
    return new Date(time).getTime()
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    const result: T[][] = []
    for (let i = 0; i < arr.length; i += size) {
        result.push(arr.slice(i, i + size))
    }
    return result
}

/** Compact relative date label for conversation list rows */
function formatConvDate(time: number | string | undefined): string {
    if (!time) return ''
    const ms = typeof time === 'number' ? time * 1000 : new Date(time).getTime()
    if (Number.isNaN(ms)) return ''
    const d = new Date(ms)
    const diffDays = Math.floor((Date.now() - ms) / 86_400_000)
    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return `${diffDays}d ago`
    if (diffDays < 365) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Text search supporting * and ? wildcards. Falls back to substring. */
function textSearch(title: string, query: string): boolean {
    const q = query.trim()
    if (!q) return true
    const lower = q.toLowerCase()
    if (!lower.includes('*') && !lower.includes('?')) {
        return title.toLowerCase().includes(lower)
    }
    const regexStr = lower
        .replace(/[\\\^$.|+()[\]{}]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
    try {
        return new RegExp(regexStr).test(title.toLowerCase())
    }
    catch {
        return title.toLowerCase().includes(lower)
    }
}

// ---------------------------------------------------------------------------
// Filter chip system
// ---------------------------------------------------------------------------

type ChipMode = 'include' | 'exclude'

type FilterChipDef =
    | { type: 'chat_class'; value: 'regular' | 'gpt' | 'project'; mode: ChipMode }
    | { type: 'origin'; value: string | null; label: string; mode: ChipMode }
    | { type: 'status'; value: 'starred' | 'temporary' | 'pinned'; mode: ChipMode }
    | { type: 'duration_gte'; days: number; mode: ChipMode }
    | { type: 'recency_lte'; days: number; mode: ChipMode }

function isChipDuplicate(chips: FilterChipDef[], candidate: FilterChipDef): boolean {
    return chips.some((c) => {
        if (c.type !== candidate.type) return false
        if (c.type === 'duration_gte' || c.type === 'recency_lte') return true
        if (c.type === 'chat_class' && candidate.type === 'chat_class') return c.value === candidate.value
        if (c.type === 'origin' && candidate.type === 'origin') return c.value === candidate.value
        if (c.type === 'status' && candidate.type === 'status') return c.value === candidate.value
        return false
    })
}

/** Returns a display label, or null for chips that render their own inline content */
function chipDisplayLabel(chip: FilterChipDef): string | null {
    switch (chip.type) {
        case 'chat_class':
            return chip.value === 'regular' ? '💬 Regular' : chip.value === 'gpt' ? '🤖 GPT' : '📂 Project'
        case 'origin':
            return `🌐 ${chip.label}`
        case 'status':
            return chip.value === 'starred' ? '⭐ Starred' : chip.value === 'temporary' ? '💬 Temporary' : '📌 Pinned'
        case 'duration_gte':
        case 'recency_lte':
            return null
    }
}

function applyChips(
    conversations: ApiConversationItem[],
    chips: FilterChipDef[],
    logic: 'AND' | 'OR',
    projects: ApiProjectInfo[],
): ApiConversationItem[] {
    if (chips.length === 0) return conversations
    const projectIdSet = new Set(projects.map(p => p.id))

    function matchSingle(c: ApiConversationItem, chip: FilterChipDef): boolean {
        let raw: boolean
        switch (chip.type) {
            case 'chat_class': {
                const gizmoId = c.gizmo_id ?? null
                const isProject = gizmoId !== null && projectIdSet.has(gizmoId)
                const isGpt = gizmoId !== null && !isProject
                if (chip.value === 'regular') raw = gizmoId === null
                else if (chip.value === 'project') raw = isProject
                else raw = isGpt
                break
            }
            case 'origin':
                raw = chip.value === null
                    ? (c.conversation_origin ?? null) === null
                    : c.conversation_origin === chip.value
                break
            case 'status':
                if (chip.value === 'starred') raw = c.is_starred === true
                else if (chip.value === 'temporary') raw = c.is_temporary_chat === true
                else raw = c.pinned_time != null
                break
            case 'duration_gte':
                raw = toMs(c.update_time) - toMs(c.create_time) >= chip.days * 86_400_000
                break
            case 'recency_lte':
                raw = Date.now() - toMs(c.update_time) <= chip.days * 86_400_000
                break
            default:
                raw = true
        }
        return chip.mode === 'include' ? raw : !raw
    }

    return logic === 'AND'
        ? conversations.filter(c => chips.every(chip => matchSingle(c, chip)))
        : conversations.filter(c => chips.some(chip => matchSingle(c, chip)))
}

// ---------------------------------------------------------------------------
// Picker option types
// ---------------------------------------------------------------------------

interface PickerOption {
    id: string
    label: string
    desc: string
    make: () => FilterChipDef
}

interface PickerGroup {
    group: string
    options: PickerOption[]
}

// ---------------------------------------------------------------------------
// DateFilter component
// ---------------------------------------------------------------------------

type DateFilterField = 'create_time' | 'update_time'

interface DateFilterProps {
    dateFrom: string
    dateTo: string
    filterField: DateFilterField
    setDateFrom: (v: string) => void
    setDateTo: (v: string) => void
    setFilterField: (v: DateFilterField) => void
    disabled: boolean
}

const DateFilter: FC<DateFilterProps> = ({ dateFrom, dateTo, filterField, setDateFrom, setDateTo, setFilterField, disabled }) => {
    const { t } = useTranslation()

    const todayStr = () => new Date().toISOString().slice(0, 10)
    const daysAgoStr = (n: number) => {
        const d = new Date()
        d.setDate(d.getDate() - n)
        return d.toISOString().slice(0, 10)
    }
    const thisYearStr = () => `${new Date().getFullYear()}-01-01`

    const presets = [
        { key: 'Date Preset 7d', from: () => daysAgoStr(7), to: todayStr },
        { key: 'Date Preset 30d', from: () => daysAgoStr(30), to: todayStr },
        { key: 'Date Preset 90d', from: () => daysAgoStr(90), to: todayStr },
        { key: 'Date Preset Year', from: thisYearStr, to: todayStr },
    ] as const

    const hasFilter = !!(dateFrom || dateTo)

    return (
        <div className="mb-3 text-sm text-gray-600 dark:text-gray-300">
            <div className="flex items-center gap-2 mb-1.5">
                <span className="shrink-0 font-medium" title={t('Date Filter Hint')}>{t('Date Filter Label')}</span>
                <select
                    className="Select"
                    value={filterField}
                    disabled={disabled}
                    onChange={e => setFilterField(e.currentTarget.value as DateFilterField)}
                    style={{ minWidth: '5.5rem' }}
                >
                    <option value="create_time">{t('Date Filter Field Created')}</option>
                    <option value="update_time">{t('Date Filter Field Updated')}</option>
                </select>
                <div className="flex items-center gap-1 ml-auto flex-wrap">
                    {presets.map(p => (
                        <button
                            key={p.key}
                            className="Button neutral"
                            style={{ padding: '2px 7px', fontSize: '0.75rem' }}
                            disabled={disabled}
                            onClick={() => {
                                setDateFrom(p.from())
                                setDateTo(p.to())
                            }}
                        >
                            {t(p.key)}
                        </button>
                    ))}
                    {hasFilter && (
                        <button
                            className="Button neutral"
                            style={{ padding: '2px 7px', fontSize: '0.75rem' }}
                            disabled={disabled}
                            onClick={() => {
                                setDateFrom('')
                                setDateTo('')
                            }}
                        >
                            {t('Clear filter')}
                        </button>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-2">
                <input
                    type="date"
                    className="Input"
                    value={dateFrom}
                    disabled={disabled}
                    onChange={e => setDateFrom(e.currentTarget.value)}
                    style={{ flex: 1, minWidth: 0 }}
                />
                <span className="shrink-0 text-gray-400">–</span>
                <input
                    type="date"
                    className="Input"
                    value={dateTo}
                    disabled={disabled}
                    onChange={e => setDateTo(e.currentTarget.value)}
                    style={{ flex: 1, minWidth: 0 }}
                />
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// ConversationSelect component
// ---------------------------------------------------------------------------

interface ConversationSelectProps {
    conversations: ApiConversationItem[]
    projects: ApiProjectInfo[]
    selected: ApiConversationItem[]
    setSelected: (selected: ApiConversationItem[]) => void
    disabled: boolean
    loading: boolean
    error: string
    dateFrom: string
    dateTo: string
    filterField: DateFilterField
}

const ConversationSelect: FC<ConversationSelectProps> = ({
    conversations,
    projects,
    selected,
    setSelected,
    disabled,
    loading,
    error,
    dateFrom,
    dateTo,
    filterField,
}) => {
    const { t } = useTranslation()
    const [query, setQuery] = useState('')
    const [chips, setChips] = useState<FilterChipDef[]>([])
    const [chipLogic, setChipLogic] = useState<'AND' | 'OR'>('AND')
    const [showPopover, setShowPopover] = useState(false)
    const lastClickedIndex = useRef<number>(-1)

    // Build picker groups dynamically — Origin values come from loaded conversations
    const pickerGroups = useMemo<PickerGroup[]>(() => {
        const originMap = new Map<string | null, string>()
        for (const c of conversations) {
            const val = c.conversation_origin ?? null
            if (!originMap.has(val)) {
                const label = val === null ? t('Chip origin web label').replace('🌐 ', '') : val.charAt(0).toUpperCase() + val.slice(1)
                originMap.set(val, label)
            }
        }

        return [
            {
                group: t('Chip group chat class'),
                options: [
                    {
                        id: 'cc_regular',
                        label: t('Chip cc regular label'),
                        desc: t('Chip cc regular desc'),
                        make: () => ({ type: 'chat_class' as const, value: 'regular' as const, mode: 'include' as const }),
                    },
                    {
                        id: 'cc_gpt',
                        label: t('Chip cc gpt label'),
                        desc: t('Chip cc gpt desc'),
                        make: () => ({ type: 'chat_class' as const, value: 'gpt' as const, mode: 'include' as const }),
                    },
                    {
                        id: 'cc_project',
                        label: t('Chip cc project label'),
                        desc: t('Chip cc project desc'),
                        make: () => ({ type: 'chat_class' as const, value: 'project' as const, mode: 'include' as const }),
                    },
                ],
            },
            {
                group: t('Chip group origin'),
                options: [...originMap.entries()].map(([val, label]) => ({
                    id: `orig_${val ?? 'null'}`,
                    label: `\u{1F310} ${label}`,
                    desc: val === null ? t('Chip origin web desc') : `Started via ${label}`,
                    make: () => ({ type: 'origin' as const, value: val, label, mode: 'include' as const }),
                })),
            },
            {
                group: t('Chip group status'),
                options: [
                    {
                        id: 'st_starred',
                        label: t('Chip status starred label'),
                        desc: t('Chip status starred desc'),
                        make: () => ({ type: 'status' as const, value: 'starred' as const, mode: 'include' as const }),
                    },
                    {
                        id: 'st_temp',
                        label: t('Chip status temporary label'),
                        desc: t('Chip status temporary desc'),
                        make: () => ({ type: 'status' as const, value: 'temporary' as const, mode: 'include' as const }),
                    },
                    {
                        id: 'st_pinned',
                        label: t('Chip status pinned label'),
                        desc: t('Chip status pinned desc'),
                        make: () => ({ type: 'status' as const, value: 'pinned' as const, mode: 'include' as const }),
                    },
                ],
            },
            {
                group: t('Chip group duration'),
                options: [
                    {
                        id: 'dur',
                        label: t('Chip duration label'),
                        desc: t('Chip duration desc'),
                        make: () => ({ type: 'duration_gte' as const, days: 7, mode: 'include' as const }),
                    },
                ],
            },
            {
                group: t('Chip group recency'),
                options: [
                    {
                        id: 'rec',
                        label: t('Chip recency label'),
                        desc: t('Chip recency desc'),
                        make: () => ({ type: 'recency_lte' as const, days: 30, mode: 'include' as const }),
                    },
                ],
            },
        ]
    }, [conversations, t])

    const availableGroups = useMemo(
        () => pickerGroups
            .map(g => ({ ...g, options: g.options.filter(opt => !isChipDuplicate(chips, opt.make())) }))
            .filter(g => g.options.length > 0),
        [pickerGroups, chips],
    )

    const filtered = useMemo(() => {
        let result = conversations
        const q = query.trim().replace(/#$/, '').trim()
        if (q) result = result.filter(c => textSearch(c.title, q))
        if (dateFrom) {
            const fromMs = new Date(dateFrom).getTime()
            if (!Number.isNaN(fromMs)) result = result.filter(c => toMs(c[filterField]) >= fromMs)
        }
        if (dateTo) {
            const toEndMs = new Date(`${dateTo}T23:59:59.999`).getTime()
            if (!Number.isNaN(toEndMs)) result = result.filter(c => toMs(c[filterField]) <= toEndMs)
        }
        return applyChips(result, chips, chipLogic, projects)
    }, [conversations, query, dateFrom, dateTo, filterField, chips, chipLogic, projects])

    const allFilteredSelected = filtered.length > 0 && filtered.every(c => selected.some(x => x.id === c.id))

    const addChip = useCallback((chip: FilterChipDef) => {
        if (isChipDuplicate(chips, chip)) return
        setChips(prev => [...prev, chip])
        setQuery(q => q.endsWith('#') ? q.slice(0, -1) : q)
        lastClickedIndex.current = -1
        setShowPopover(false)
    }, [chips])

    const updateChip = useCallback((index: number, updated: FilterChipDef) => {
        setChips(prev => prev.map((c, i) => i === index ? updated : c))
    }, [])

    const removeChip = useCallback((index: number) => {
        setChips(prev => prev.filter((_, i) => i !== index))
    }, [])

    const toggleChipMode = useCallback((index: number) => {
        setChips(prev => prev.map((c, i) => i === index ? { ...c, mode: c.mode === 'include' ? 'exclude' : 'include' } as FilterChipDef : c))
    }, [])

    return (
        <>
            {/* Active filter chips bar */}
            {chips.length > 0 && (
                <div className="SelectChips">
                    {chips.length > 1 && (
                        <button
                            className={`SelectChipLogic${chipLogic === 'OR' ? ' SelectChipLogicOr' : ''}`}
                            title="Toggle AND / OR logic between filters"
                            onClick={() => setChipLogic(l => l === 'AND' ? 'OR' : 'AND')}
                        >
                            {chipLogic === 'AND' ? t('Chip logic and') : t('Chip logic or')}
                        </button>
                    )}
                    {chips.map((chip, i) => {
                        const label = chipDisplayLabel(chip)
                        const isExclude = chip.mode === 'exclude'
                        return (
                            <span key={i} className={`SelectChip${isExclude ? ' SelectChipExclude' : ''}`}>
                                {label !== null && label}
                                {chip.type === 'duration_gte' && (
                                    <>
                                        {t('Chip duration prefix')}&nbsp;
                                        <input
                                            type="number"
                                            min="1"
                                            value={chip.days}
                                            onChange={e => updateChip(i, { type: 'duration_gte', days: Math.max(1, Number(e.currentTarget.value)), mode: chip.mode })}
                                        />
                                        {t('Chip duration suffix')}
                                    </>
                                )}
                                {chip.type === 'recency_lte' && (
                                    <>
                                        {t('Chip recency prefix')}&nbsp;
                                        <input
                                            type="number"
                                            min="1"
                                            value={chip.days}
                                            onChange={e => updateChip(i, { type: 'recency_lte', days: Math.max(1, Number(e.currentTarget.value)), mode: chip.mode })}
                                        />
                                        {t('Chip recency suffix')}
                                    </>
                                )}
                                <button
                                    className={`SelectChipMode${isExclude ? ' SelectChipModeExclude' : ''}`}
                                    title={isExclude ? 'Currently excluding — click to include instead' : 'Currently including — click to exclude instead'}
                                    onClick={() => toggleChipMode(i)}
                                >
                                    {isExclude ? t('Chip mode exclude') : t('Chip mode include')}
                                </button>
                                <button className="SelectChipRemove" onClick={() => removeChip(i)}>×</button>
                            </span>
                        )
                    })}
                </div>
            )}

            {/* Search input — type # to open filter picker */}
            <div className="relative">
                <input
                    type="search"
                    className="SelectSearch"
                    style={chips.length > 0 ? { borderRadius: 0 } : undefined}
                    placeholder={chips.length > 0 ? t('Search') : `${t('Search')} — ${t('Filters hint')}`}
                    value={query}
                    disabled={disabled}
                    onInput={(e) => {
                        const val = (e.currentTarget as HTMLInputElement).value
                        lastClickedIndex.current = -1
                        setQuery(val)
                        setShowPopover(val.endsWith('#') && availableGroups.length > 0)
                    }}
                    onBlur={() => setTimeout(() => setShowPopover(false), 180)}
                />
                {showPopover && (
                    <div className="SelectFilterPopover">
                        {availableGroups.map(g => (
                            <div key={g.group}>
                                <div className="SelectFilterGroupHeader">{g.group}</div>
                                {g.options.map(opt => (
                                    <button
                                        key={opt.id}
                                        className="SelectFilterOption"
                                        onMouseDown={(e) => {
                                            e.preventDefault()
                                            addChip(opt.make())
                                        }}
                                    >
                                        <strong>{opt.label}</strong>
                                        <small>{opt.desc}</small>
                                    </button>
                                ))}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Toolbar: select-all + last-100 + counter */}
            <div className="SelectToolbar">
                <CheckBox
                    label={t('Select All')}
                    disabled={disabled}
                    checked={allFilteredSelected}
                    onCheckedChange={(checked) => {
                        lastClickedIndex.current = -1
                        setSelected(checked ? filtered : [])
                    }}
                />
                <div className="flex items-center gap-2 ml-auto">
                    {loading && conversations.length > 0 && (
                        <span className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
                            <IconLoading className="w-3 h-3" />
                            {t('Loading')}... ({conversations.length})
                        </span>
                    )}
                    <button
                        className="Button neutral"
                        disabled={disabled || conversations.length === 0}
                        onClick={() => setSelected(filtered.slice(0, EXPORT_OPERATION_BATCH))}
                    >
                        {t('Last 100')}
                    </button>
                    <span className="text-sm font-medium tabular-nums text-gray-500 dark:text-gray-400">
                        {selected.length} / {filtered.length}
                    </span>
                </div>
            </div>

            {/* Conversation list */}
            <ul className="SelectList">
                {loading && conversations.length === 0 && <li className="SelectItem">{t('Loading')}...</li>}
                {error && <li className="SelectItem">{t('Error')}: {error}</li>}
                {filtered.map((c, index) => {
                    const isSelected = selected.some(x => x.id === c.id)
                    return (
                        <li
                            className="SelectItem"
                            key={c.id}
                            onClickCapture={(e: MouseEvent) => {
                                if (disabled) return
                                if (e.shiftKey && lastClickedIndex.current !== -1) {
                                    e.preventDefault()
                                    const start = Math.min(lastClickedIndex.current, index)
                                    const end = Math.max(lastClickedIndex.current, index)
                                    const rangeItems = filtered.slice(start, end + 1)
                                    const newSelected = [...selected]
                                    for (const item of rangeItems) {
                                        if (!newSelected.some(x => x.id === item.id)) newSelected.push(item)
                                    }
                                    setSelected(newSelected)
                                    return
                                }
                                lastClickedIndex.current = index
                            }}
                        >
                            <CheckBox
                                label={c.title}
                                disabled={disabled}
                                checked={isSelected}
                                onCheckedChange={(checked) => {
                                    setSelected(checked ? [...selected, c] : selected.filter(x => x.id !== c.id))
                                }}
                            />
                            <span className="SelectItemMeta">{formatConvDate(c.create_time)}</span>
                            {c.is_starred && <span title="Starred" style={{ color: '#f59e0b', flexShrink: 0 }}>★</span>}
                        </li>
                    )
                })}
                {!loading && !error && filtered.length === 0 && conversations.length > 0 && (
                    <li className="SelectItem text-gray-400 dark:text-gray-500">{t('No results')}</li>
                )}
            </ul>
        </>
    )
}

// ---------------------------------------------------------------------------
// DialogContent component
// ---------------------------------------------------------------------------

type ExportSource = 'API' | 'Local'

interface DialogContentProps {
    format: string
}

const DialogContent: FC<DialogContentProps> = ({ format }) => {
    const { t } = useTranslation()
    const { enableMeta, exportMetaList, exportAllLimit } = useSettingContext()
    const metaList = useMemo(() => enableMeta ? exportMetaList : [], [enableMeta, exportMetaList])

    const exportAllOptions = useMemo(() => [
        { label: 'Markdown', callback: exportAllToMarkdown },
        { label: 'HTML', callback: exportAllToHtml },
        { label: 'JSON', callback: exportAllToOfficialJson },
        { label: 'JSON (ZIP)', callback: exportAllToJson },
    ], [])

    const fileInputRef = useRef<HTMLInputElement>(null)
    const [exportSource, setExportSource] = useState<ExportSource>('API')
    const [apiConversations, setApiConversations] = useState<ApiConversationItem[]>([])
    const [localConversations, setLocalConversations] = useState<ApiConversationWithId[]>([])
    const conversations = exportSource === 'API' ? apiConversations : localConversations
    const [projects, setProjects] = useState<ApiProjectInfo[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [processing, setProcessing] = useState(false)

    const [selected, setSelected] = useState<ApiConversationItem[]>([])
    const [exportType, setExportType] = useState(exportAllOptions[0].label)
    const [dateFrom, setDateFrom] = useState('')
    const [dateTo, setDateTo] = useState('')
    const [filterField, setFilterField] = useState<DateFilterField>('create_time')
    const disabled = processing || !!error || selected.length === 0

    // "Load more" state
    const [hasMore, setHasMore] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    const [totalAvailable, setTotalAvailable] = useState<number | null>(null)

    const requestQueue = useMemo(() => new RequestQueue<ApiConversationWithId>(200, 1600), [])
    const archiveQueue = useMemo(() => new RequestQueue<boolean>(200, 1600), [])
    const deleteQueue = useMemo(() => new RequestQueue<boolean>(200, 1600), [])

    const [progress, setProgress] = useState({
        total: 0,
        completed: 0,
        currentName: '',
        currentStatus: '',
        batchIndex: 0,
        totalBatches: 0,
    })

    const pendingBatchesRef = useRef<ApiConversationItem[][]>([])
    const batchIndexRef = useRef(0)
    const totalBatchesRef = useRef(0)

    const onUpload = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        const file = (e.target as HTMLInputElement)?.files?.[0]
        if (!file) return
        const fileReader = new FileReader()
        fileReader.onload = () => {
            const data = JSON.parse(fileReader.result as string)
            if (!Array.isArray(data)) {
                alert(t('Invalid File Format'))
                return
            }
            setSelected([])
            setExportSource('Local')
            setLocalConversations(data)
        }
        fileReader.readAsText(file)
    }, [t])

    const startApiBatch = useCallback((chunk: ApiConversationItem[]) => {
        requestQueue.clear()
        chunk.forEach(({ id, title }) => {
            requestQueue.add({ name: title, request: () => fetchConversation(id, exportType !== 'JSON') })
        })
        requestQueue.start()
    }, [requestQueue, exportType])

    useEffect(() => {
        const off = requestQueue.on('progress', (prog) => {
            setProcessing(true)
            setProgress({
                ...prog,
                batchIndex: batchIndexRef.current,
                totalBatches: totalBatchesRef.current,
                completed: batchIndexRef.current * EXPORT_OPERATION_BATCH + prog.completed,
                total: totalBatchesRef.current * EXPORT_OPERATION_BATCH,
            })
        })
        return () => off()
    }, [requestQueue])

    useEffect(() => {
        const off = archiveQueue.on('progress', (prog) => {
            setProcessing(true)
            setProgress({ ...prog, batchIndex: 0, totalBatches: 0 })
        })
        return () => off()
    }, [archiveQueue])

    useEffect(() => {
        const off = deleteQueue.on('progress', (prog) => {
            setProcessing(true)
            setProgress({ ...prog, batchIndex: 0, totalBatches: 0 })
        })
        return () => off()
    }, [deleteQueue])

    useEffect(() => {
        const off = requestQueue.on('done', async (results) => {
            const batchIdx = batchIndexRef.current
            const totalBatches = totalBatchesRef.current
            const partIndex = batchIdx + 1
            const callback = exportAllOptions.find(o => o.label === exportType)?.callback
            if (callback) {
                await callback(format, results, metaList, undefined, partIndex, totalBatches)
            }
            if (partIndex < totalBatches) {
                await sleep(400)
                batchIndexRef.current++
                const nextChunk = pendingBatchesRef.current[batchIndexRef.current]
                if (nextChunk) startApiBatch(nextChunk)
            }
            else {
                setProcessing(false)
            }
        })
        return () => off()
    }, [requestQueue, exportAllOptions, exportType, format, metaList, startApiBatch])

    useEffect(() => {
        const off = archiveQueue.on('done', () => {
            setProcessing(false)
            setApiConversations(prev => prev.filter(c => !selected.some(s => s.id === c.id)))
            setSelected([])
            alert(t('Conversation Archived Message'))
        })
        return () => off()
    }, [archiveQueue, selected, t])

    useEffect(() => {
        const off = deleteQueue.on('done', () => {
            setProcessing(false)
            setApiConversations(prev => prev.filter(c => !selected.some(s => s.id === c.id)))
            setSelected([])
            alert(t('Conversation Deleted Message'))
        })
        return () => off()
    }, [deleteQueue, selected, t])

    const exportAllFromApi = useCallback(() => {
        if (disabled) return
        const chunks = chunkArray(selected, EXPORT_OPERATION_BATCH)
        pendingBatchesRef.current = chunks
        batchIndexRef.current = 0
        totalBatchesRef.current = chunks.length
        setProcessing(true)
        setProgress({
            total: selected.length,
            completed: 0,
            currentName: '',
            currentStatus: 'processing',
            batchIndex: 0,
            totalBatches: chunks.length,
        })
        startApiBatch(chunks[0])
    }, [disabled, selected, startApiBatch])

    const exportAllFromLocal = useCallback(async () => {
        if (disabled) return
        const results = localConversations.filter(c => selected.some(s => s.id === c.id))
        const callback = exportAllOptions.find(o => o.label === exportType)?.callback
        if (!callback) return
        const chunks = chunkArray(results, EXPORT_OPERATION_BATCH)
        setProcessing(true)
        for (let i = 0; i < chunks.length; i++) {
            await callback(format, chunks[i], metaList, undefined, i + 1, chunks.length)
            if (i < chunks.length - 1) await sleep(400)
        }
        setProcessing(false)
    }, [disabled, selected, localConversations, exportAllOptions, exportType, format, metaList])

    const exportAll = useMemo(() => {
        return exportSource === 'API' ? exportAllFromApi : exportAllFromLocal
    }, [exportSource, exportAllFromApi, exportAllFromLocal])

    const deleteAll = useCallback(() => {
        if (disabled) return
        if (!confirm(t('Conversation Delete Alert'))) return
        deleteQueue.clear()
        selected.forEach(({ id, title }) => {
            deleteQueue.add({ name: title, request: () => deleteConversation(id) })
        })
        deleteQueue.start()
    }, [disabled, selected, deleteQueue, t])

    const archiveAll = useCallback(() => {
        if (disabled) return
        if (!confirm(t('Conversation Archive Alert'))) return
        archiveQueue.clear()
        selected.forEach(({ id, title }) => {
            archiveQueue.add({ name: title, request: () => archiveConversation(id) })
        })
        archiveQueue.start()
    }, [disabled, selected, archiveQueue, t])

    // Fetch projects in the background for chat-class chip resolution
    useEffect(() => {
        fetchProjects()
            .then(setProjects)
            .catch(err => console.error('Failed to fetch projects:', err))
    }, [])

    // Auto-load all conversations from the main endpoint on dialog open
    useEffect(() => {
        setSelected([])
        setApiConversations([])
        setHasMore(false)
        setTotalAvailable(null)
        setLoading(true)
        fetchAllConversations(null, exportAllLimit, batch => setApiConversations(prev => [...prev, ...batch]), setHasMore)
            .catch((err: Error) => {
                console.error('Error fetching conversations:', err)
                setError(err.message || 'Failed to load conversations')
            })
            .finally(() => setLoading(false))
    }, [exportAllLimit])

    const loadMore = useCallback(async () => {
        if (loadingMore) return
        setLoadingMore(true)
        try {
            const page = await fetchConversationsPage(null, apiConversations.length, EXPORT_OPERATION_BATCH)
            setApiConversations(prev => [...prev, ...page.items])
            if (page.total !== null) setTotalAvailable(page.total)
            setHasMore(
                page.items.length >= EXPORT_OPERATION_BATCH
                && (page.total === null || apiConversations.length + page.items.length < page.total),
            )
        }
        catch (err) {
            console.error('loadMore error', err)
        }
        finally {
            setLoadingMore(false)
        }
    }, [loadingMore, apiConversations.length])

    const totalBatches = Math.ceil(selected.length / EXPORT_OPERATION_BATCH) || 1

    return (
        <>
            <Dialog.Title className="DialogTitle">{t('Export Dialog Title')}</Dialog.Title>
            <div className="flex items-center text-gray-600 dark:text-gray-300 flex justify-between border-b-[1px] pb-3 mb-3 dark:border-gray-700">
                {t('Export from official export file')} (conversations.json)&nbsp;
                {exportSource === 'API' && (
                    <button className="btn relative btn-neutral" onClick={() => fileInputRef.current?.click()}>
                        <IconUpload className="w-4 h-4" />
                    </button>
                )}
            </div>
            <input
                type="file"
                accept="application/json"
                className="hidden"
                ref={fileInputRef}
                onChange={onUpload}
            />
            <DateFilter
                dateFrom={dateFrom}
                dateTo={dateTo}
                filterField={filterField}
                setDateFrom={setDateFrom}
                setDateTo={setDateTo}
                setFilterField={setFilterField}
                disabled={processing}
            />
            <ConversationSelect
                conversations={conversations}
                projects={projects}
                selected={selected}
                setSelected={setSelected}
                disabled={processing}
                loading={loading}
                error={error}
                dateFrom={dateFrom}
                dateTo={dateTo}
                filterField={filterField}
            />

            {/* Load-more button — shown when more pages exist beyond the initial fetch */}
            {exportSource === 'API' && !loading && !processing && hasMore && (
                <div className="flex items-center justify-center mt-2 mb-1 gap-2">
                    <button
                        className="Button neutral"
                        style={{ fontSize: '0.8rem', padding: '4px 14px' }}
                        disabled={loadingMore}
                        onClick={loadMore}
                    >
                        {loadingMore
                            ? `${t('Loading')}...`
                            : totalAvailable !== null
                                ? t('Load more conversations remaining', { n: EXPORT_OPERATION_BATCH, remaining: totalAvailable - apiConversations.length })
                                : t('Load more conversations', { n: EXPORT_OPERATION_BATCH })}
                    </button>
                    {totalAvailable !== null && !loadingMore && (
                        <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                            {apiConversations.length} / {totalAvailable}
                        </span>
                    )}
                </div>
            )}

            <div className="flex mt-3 items-center gap-2">
                <select className="Select shrink-0" disabled={processing} value={exportType} onChange={e => setExportType(e.currentTarget.value)}>
                    {exportAllOptions.map(({ label }) => (
                        <option key={t(label)} value={label}>{label}</option>
                    ))}
                </select>
                <div className="flex flex-grow"></div>
                <button className="Button red" disabled={disabled || exportSource === 'Local'} onClick={archiveAll}>
                    {t('Archive')}
                </button>
                <button className="Button red" disabled={disabled || exportSource === 'Local'} onClick={deleteAll}>
                    {t('Delete')}
                </button>
                <button className="Button green" disabled={disabled} onClick={exportAll}>
                    {t('Export')}
                </button>
            </div>
            {totalBatches > 1 && !processing && (
                <p className="mt-1.5 text-xs text-right text-gray-400 dark:text-gray-500">
                    {`${totalBatches} downloads \u00B7 100 conversations each`}
                </p>
            )}
            {processing && (
                <>
                    <div className="mt-2 mb-1 justify-between flex items-center gap-2">
                        <span className="truncate text-sm text-gray-600 dark:text-gray-300">{progress.currentName}</span>
                        <span className="shrink-0 tabular-nums text-sm text-gray-500 dark:text-gray-400">
                            {progress.totalBatches > 1
                                ? `${t('Batch progress').replace('{{current}}', String(progress.batchIndex + 1)).replace('{{total}}', String(progress.totalBatches))} \u00B7 ${progress.completed}/${progress.total}`
                                : `${progress.completed}/${progress.total}`}
                        </span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2.5 mb-4 dark:bg-gray-700">
                        <div
                            className="bg-blue-600 h-2.5 rounded-full"
                            style={{ width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%` }}
                        />
                    </div>
                </>
            )}
            <Dialog.Close asChild>
                <button className="IconButton CloseButton" aria-label="Close">
                    <IconCross />
                </button>
            </Dialog.Close>
        </>
    )
}

// ---------------------------------------------------------------------------
// ExportDialog (root)
// ---------------------------------------------------------------------------

interface ExportDialogProps {
    format: string
    open: boolean
    onOpenChange: (value: boolean) => void
}

export const ExportDialog: FC<ExportDialogProps> = ({ format, open, onOpenChange, children }) => {
    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Trigger asChild>
                {children}
            </Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="DialogOverlay" />
                <Dialog.Content className="DialogContent">
                    {open && <DialogContent format={format} />}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
