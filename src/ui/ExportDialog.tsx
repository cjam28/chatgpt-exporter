import * as Dialog from '@radix-ui/react-dialog'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useTranslation } from 'react-i18next'
import { archiveConversation, deleteConversation, fetchAllConversations, fetchConversation, fetchProjects } from '../api'
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

/**
 * Normalise create_time / update_time to milliseconds so we can compare
 * against Date.getTime() values regardless of whether the API returned an
 * ISO 8601 string (current behaviour) or a Unix-seconds number (legacy).
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

interface ProjectSelectProps {
    projects: ApiProjectInfo[]
    selected: ApiProjectInfo | null | undefined
    setSelected: (selected: ApiProjectInfo | null) => void
    disabled: boolean
}

const ProjectSelect: FC<ProjectSelectProps> = ({ projects, selected, setSelected, disabled }) => {
    const { t } = useTranslation()

    const value = selected === undefined ? '__unselected__' : (selected?.id || '')

    return (
        <div className="flex items-center text-gray-600 dark:text-gray-300 flex justify-between mb-3">
            {t('Select Project')}
            <select
                disabled={disabled}
                className="Select"
                value={value}
                onChange={(e) => {
                    const projectId = e.currentTarget.value
                    const project = projects.find(p => p.id === projectId)
                    setSelected(project || null)
                }}
            >
                {selected === undefined && (
                    <option value="__unselected__" disabled>{t('Select Project')}...</option>
                )}
                <option value="">{t('(no project)')}</option>
                {projects.map(project => (
                    <option key={project.id} value={project.id}>{project.display.name}</option>
                ))}
            </select>
        </div>
    )
}

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
            {/* Row 1: field selector + quick presets */}
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
            {/* Row 2: From – To inputs */}
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

interface ConversationSelectProps {
    conversations: ApiConversationItem[]
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
    const lastClickedIndex = useRef<number>(-1)

    const filtered = useMemo(() => {
        let result = conversations
        const q = query.trim().toLowerCase()
        if (q) result = result.filter(c => c.title.toLowerCase().includes(q))
        if (dateFrom) {
            const fromMs = new Date(dateFrom).getTime()
            if (!Number.isNaN(fromMs)) {
                result = result.filter(c => toMs(c[filterField]) >= fromMs)
            }
        }
        if (dateTo) {
            // Include the full end-of-day in local time
            const toEndMs = new Date(`${dateTo}T23:59:59.999`).getTime()
            if (!Number.isNaN(toEndMs)) {
                result = result.filter(c => toMs(c[filterField]) <= toEndMs)
            }
        }
        return result
    }, [conversations, query, dateFrom, dateTo, filterField])

    const allFilteredSelected = filtered.length > 0
        && filtered.every(c => selected.some(x => x.id === c.id))

    return (
        <>
            <input
                type="search"
                className="SelectSearch"
                placeholder={t('Search')}
                value={query}
                onInput={(e) => {
                    lastClickedIndex.current = -1
                    setQuery(e.currentTarget.value)
                }}
            />
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
                                        if (!newSelected.some(x => x.id === item.id)) {
                                            newSelected.push(item)
                                        }
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
                                    setSelected(checked
                                        ? [...selected, c]
                                        : selected.filter(x => x.id !== c.id),
                                    )
                                }}
                            />
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
    // Start with null (no project) so conversations load immediately on dialog open.
    // undefined means "not yet chosen" and shows the placeholder message.
    const [selectedProject, setSelectedProject] = useState<ApiProjectInfo | null | undefined>(null)

    const [selected, setSelected] = useState<ApiConversationItem[]>([])
    const [exportType, setExportType] = useState(exportAllOptions[0].label)
    const [dateFrom, setDateFrom] = useState('')
    const [dateTo, setDateTo] = useState('')
    const [filterField, setFilterField] = useState<DateFilterField>('create_time')
    const disabled = processing || !!error || selected.length === 0

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

    // Refs tracking wave-based batch state across async event handlers
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
    }, [t, setExportSource, setLocalConversations])

    // Start fetching one batch of conversations
    const startApiBatch = useCallback((chunk: ApiConversationItem[]) => {
        requestQueue.clear()
        chunk.forEach(({ id, title }) => {
            requestQueue.add({
                name: title,
                request: () => fetchConversation(id, exportType !== 'JSON'),
            })
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
                // Accumulate global completed count across batches
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

    // Wave-based done handler: download the finished batch then kick off the next one
    useEffect(() => {
        const off = requestQueue.on('done', async (results) => {
            const batchIdx = batchIndexRef.current
            const totalBatches = totalBatchesRef.current
            const partIndex = batchIdx + 1
            const callback = exportAllOptions.find(o => o.label === exportType)?.callback
            if (callback) {
                await callback(format, results, metaList, selectedProject?.display.name, partIndex, totalBatches)
            }
            if (partIndex < totalBatches) {
                // Brief pause before the next wave to avoid back-to-back browser downloads
                // and give the ChatGPT API a moment to breathe
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
    }, [requestQueue, exportAllOptions, exportType, format, metaList, selectedProject, startApiBatch])

    useEffect(() => {
        const off = archiveQueue.on('done', () => {
            setProcessing(false)
            setApiConversations(apiConversations.filter(c => !selected.some(s => s.id === c.id)))
            setSelected([])
            alert(t('Conversation Archived Message'))
        })
        return () => off()
    }, [archiveQueue, apiConversations, selected, t])

    useEffect(() => {
        const off = deleteQueue.on('done', () => {
            setProcessing(false)
            setApiConversations(apiConversations.filter(c => !selected.some(s => s.id === c.id)))
            setSelected([])
            alert(t('Conversation Deleted Message'))
        })
        return () => off()
    }, [deleteQueue, apiConversations, selected, t])

    // Kick off wave export: split selected into 100-conversation batches and process the first
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

    // Local-source export: also batched in waves of 100, but no API fetch needed
    const exportAllFromLocal = useCallback(async () => {
        if (disabled) return
        const results = localConversations.filter(c => selected.some(s => s.id === c.id))
        const callback = exportAllOptions.find(o => o.label === exportType)?.callback
        if (!callback) return
        const chunks = chunkArray(results, EXPORT_OPERATION_BATCH)
        setProcessing(true)
        for (let i = 0; i < chunks.length; i++) {
            await callback(format, chunks[i], metaList, selectedProject?.display.name, i + 1, chunks.length)
            if (i < chunks.length - 1) await sleep(400)
        }
        setProcessing(false)
    }, [
        disabled,
        selected,
        localConversations,
        exportAllOptions,
        exportType,
        format,
        metaList,
        selectedProject,
    ])

    const exportAll = useMemo(() => {
        return exportSource === 'API' ? exportAllFromApi : exportAllFromLocal
    }, [exportSource, exportAllFromApi, exportAllFromLocal])

    const deleteAll = useCallback(() => {
        if (disabled) return

        const result = confirm(t('Conversation Delete Alert'))
        if (!result) return

        deleteQueue.clear()

        selected.forEach(({ id, title }) => {
            deleteQueue.add({
                name: title,
                request: () => deleteConversation(id),
            })
        })

        deleteQueue.start()
    }, [disabled, selected, deleteQueue, t])

    const archiveAll = useCallback(() => {
        if (disabled) return

        const result = confirm(t('Conversation Archive Alert'))
        if (!result) return

        archiveQueue.clear()

        selected.forEach(({ id, title }) => {
            archiveQueue.add({
                name: title,
                request: () => archiveConversation(id),
            })
        })

        archiveQueue.start()
    }, [disabled, selected, archiveQueue, t])

    useEffect(() => {
        fetchProjects()
            .then(setProjects)
            .catch(err => setError(err.toString()))
    }, [])

    useEffect(() => {
        if (selectedProject === undefined) return
        setSelected([])
        setApiConversations([])
        setLoading(true)
        fetchAllConversations(
            selectedProject?.id ?? null,
            exportAllLimit,
            batch => setApiConversations(prev => [...prev, ...batch]),
        )
            .catch((err) => {
                console.error('Error fetching conversations:', err)
                setError(err.message || 'Failed to load conversations')
            })
            .finally(() => setLoading(false))
    }, [selectedProject, exportAllLimit])

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
            {exportSource === 'API' && (
                <ProjectSelect projects={projects} selected={selectedProject} setSelected={setSelectedProject} disabled={processing} />
            )}
            <DateFilter
                dateFrom={dateFrom}
                dateTo={dateTo}
                filterField={filterField}
                setDateFrom={setDateFrom}
                setDateTo={setDateTo}
                setFilterField={setFilterField}
                disabled={processing}
            />
            {selectedProject === undefined
                ? (
                    <div className="SelectList flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">
                        {t('Select a source to load conversations')}
                    </div>
                    )
                : (
                    <ConversationSelect
                        key={selectedProject?.id ?? 'no-project'}
                        conversations={conversations}
                        selected={selected}
                        setSelected={setSelected}
                        disabled={processing}
                        loading={loading}
                        error={error}
                        dateFrom={dateFrom}
                        dateTo={dateTo}
                        filterField={filterField}
                    />
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
                <button
                    className="Button green"
                    disabled={disabled}
                    onClick={exportAll}
                    title={totalBatches > 1 ? `${totalBatches} separate downloads, 100 conversations each` : undefined}
                >
                    {totalBatches > 1 ? `${t('Export')} \u00B7\u00A0${totalBatches}\u00A0files` : t('Export')}
                </button>
            </div>
            {processing && (
                <>
                    <div className="mt-2 mb-1 justify-between flex items-center gap-2">
                        <span className="truncate text-sm text-gray-600 dark:text-gray-300">{progress.currentName}</span>
                        <span className="shrink-0 tabular-nums text-sm text-gray-500 dark:text-gray-400">
                            {progress.totalBatches > 1
                                ? `${t('Batch progress').replace('{{current}}', String(progress.batchIndex + 1)).replace('{{total}}', String(progress.totalBatches))} · ${progress.completed}/${progress.total}`
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

interface ExportDialogProps {
    format: string
    open: boolean
    onOpenChange: (value: boolean) => void
}

export const ExportDialog: FC<ExportDialogProps> = ({ format, open, onOpenChange, children }) => {
    return (
        <Dialog.Root
            open={open}
            onOpenChange={onOpenChange}
        >
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
