import EventEmitter from 'mitt'
import { RateLimitError } from '../api'
import { sleep } from './utils'

type RequestFn<T> = () => Promise<T>

/** Public shape callers pass to `add()` */
interface RequestObject<T> {
    name: string
    request: RequestFn<T>
}

/** Internal shape with per-item retry counters */
interface InternalRequestObject<T> extends RequestObject<T> {
    retries: number // general error retries
    rateRetries: number // 429-specific retries
}

export type RequestStatus = 'processing' | 'retrying' | 'rate_limited'

interface ProgressEvent {
    total: number
    completed: number
    currentName: string
    currentStatus: RequestStatus
    /** Seconds remaining in a rate-limit pause (only set when status === 'rate_limited') */
    rateLimitWaitSecs?: number
}

/** Max retries for generic (non-429) errors before skipping a request */
const MAX_RETRIES = 5
/** Max retries specifically for 429 before skipping a request */
const MAX_429_RETRIES = 8
/** Minimum ms to wait after a 429 when no Retry-After header is present */
const MIN_429_BACKOFF_MS = 30_000

export class RequestQueue<T> {
    private eventEmitter = EventEmitter<{
        done: T[]
        progress: ProgressEvent
    } & Record<string, any[]>>()

    private queue: Array<InternalRequestObject<T>> = []
    private results: T[] = []

    private status: 'IDLE' | 'IN_PROGRESS' | 'STOPPED' | 'COMPLETED' = 'IDLE'

    private readonly backoffMultiplier = 2
    private backoff: number

    private total = 0
    private completed = 0

    constructor(private minBackoff: number, private maxBackoff: number) {
        this.backoff = minBackoff
    }

    add(requestObject: RequestObject<T>) {
        this.queue.push({ ...requestObject, retries: 0, rateRetries: 0 })
    }

    start() {
        if (this.status === 'IDLE') {
            this.total = this.queue.length
            this.process()
        }
    }

    stop() {
        this.status = 'STOPPED'
        this.eventEmitter.emit('done', this.results)
    }

    clear() {
        this.queue = []
        this.results = []
        this.status = 'IDLE'
        this.backoff = this.minBackoff
        this.total = 0
        this.completed = 0
    }

    on(event: 'progress', fn: (progress: ProgressEvent) => void): () => void
    on(event: 'done', fn: (result: T[]) => void): () => void
    on(event: string, fn: (...args: any[]) => void): () => void {
        this.eventEmitter.on(event, fn)
        return () => this.eventEmitter.off(event, fn)
    }

    private async process() {
        if (this.status === 'STOPPED' || this.status === 'COMPLETED') {
            return
        }

        if (this.queue.length === 0) {
            this.done()
            return
        }

        this.status = 'IN_PROGRESS'
        const requestObject = this.queue.shift()!
        const { name, request } = requestObject

        let waitMs = this.backoff

        try {
            this.progress(name, 'processing')
            const result = await request()
            this.results.push(result)
            this.completed++
            this.progress(name, 'processing')
            this.backoff = this.minBackoff // reset on success
            requestObject.retries = 0
            requestObject.rateRetries = 0
        }
        catch (error) {
            if (error instanceof RateLimitError) {
                requestObject.rateRetries++
                if (requestObject.rateRetries > MAX_429_RETRIES) {
                    console.warn(`[Exporter] "${name}" skipped after ${MAX_429_RETRIES} rate-limit retries`)
                    waitMs = 0 // skip — don't re-queue
                }
                else {
                    waitMs = Math.max(error.retryAfterMs, MIN_429_BACKOFF_MS)
                    this.progress(name, 'rate_limited', Math.round(waitMs / 1000))
                    this.queue.unshift(requestObject) // retry this item next
                }
            }
            else {
                console.error(`[Exporter] "${name}" failed:`, error)
                requestObject.retries++
                if (requestObject.retries > MAX_RETRIES) {
                    console.warn(`[Exporter] "${name}" skipped after ${MAX_RETRIES} retries`)
                    waitMs = 0 // skip — don't re-queue
                }
                else {
                    this.backoff = Math.min(this.backoff * this.backoffMultiplier, this.maxBackoff)
                    waitMs = this.backoff
                    this.progress(name, 'retrying')
                    this.queue.unshift(requestObject)
                }
            }
        }

        await sleep(waitMs)
        this.process()
    }

    private progress(name: string, status: RequestStatus, rateLimitWaitSecs?: number) {
        this.eventEmitter.emit('progress', {
            total: this.total,
            completed: this.completed,
            currentName: name,
            currentStatus: status,
            rateLimitWaitSecs,
        })
    }

    private done() {
        this.status = 'COMPLETED'
        this.eventEmitter.emit('done', this.results)
    }
}
