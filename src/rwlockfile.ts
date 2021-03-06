import { lockfile, onceAtATime } from './decorators'
import * as FS from 'fs-extra'
import * as path from 'path'
import Lockfile, { LockfileOptions } from './lockfile'
import { RWLockfileError } from './errors'
import * as isProcessActive from 'is-process-active'

const version = require('../package.json').version

export type ReadStatus =
  | {
      status: 'open'
      file: string
    }
  | {
      status: 'write_lock'
      job: Job
      file: string
    }

export type WriteStatus =
  | ReadStatus
  | {
      status: 'read_lock'
      file: string
      jobs: Job[]
    }

export type Status = WriteStatus

export interface RWLockOptions {
  reason?: string
  ifLocked?: IfLockedFn
  timeout?: number
  retryInterval?: number
}

export interface RWLockfileOptions extends LockfileOptions {
  timeout?: number
  retryInterval?: number
  ifLocked?: IfLockedFn
}

export type RWLockType = 'read' | 'write'

export interface Job {
  uuid: string
  pid: number
  reason?: string
  created: Date
}

interface RWLockfileJSON {
  version: string
  writer?: Job
  readers: Job[]
}

export interface IfLockedFn {
  ({ status }: { status: Status }): Promise<void> | void
}

export class RWLockfile {
  public base: string
  public ifLocked: IfLockedFn
  public timeout: number
  public retryInterval: number
  private _debug: any
  private uuid: string
  private fs: typeof FS
  // @ts-ignore
  private internal: Lockfile
  private _count: { read: number; write: number } = { read: 0, write: 0 }

  /**
   * creates a new read/write lockfile
   * @param base {string} - base filepath to create lock from
   */
  constructor(base: string, options: RWLockfileOptions = {}) {
    this.base = base
    this._debug = options.debug || (debugEnvVar() && require('debug')('rwlockfile'))
    this.uuid = require('uuid/v4')()
    this.fs = require('fs-extra')
    this.timeout = options.timeout || 30000
    this.retryInterval = options.retryInterval || 10
    this.ifLocked = options.ifLocked || (() => {})
    instances.push(this)
    this.internal = new Lockfile(this.file, {
      debug: debugEnvVar() === 2 && this._debug,
    })
  }

  get count(): { readonly read: number; readonly write: number } {
    return { read: this._count.read, write: this._count.write }
  }
  get file() {
    return path.resolve(this.base + '.lock')
  }

  async add(type: RWLockType, opts: RWLockOptions = {}) {
    this._debugReport('add', type, opts)
    if (!this._count[type]) await this._lock(type, opts)
    this._count[type]++
  }

  addSync(type: RWLockType, opts: { reason?: string } = {}): void {
    this._debugReport('addSync', type, opts)
    this._lockSync(type, opts.reason)
  }

  async remove(type: RWLockType): Promise<void> {
    this._debugReport('remove', type)
    switch (this.count[type]) {
      case 0:
        break
      case 1:
        await this.unlock(type)
        break
      default:
        this._count[type]--
        break
    }
  }

  removeSync(type: RWLockType): void {
    this._debugReport('removeSync', type)
    switch (this.count[type]) {
      case 0:
        break
      case 1:
        this.unlockSync(type)
        break
      default:
        this._count[type]--
        break
    }
  }

  async unlock(type?: RWLockType): Promise<void> {
    if (!type) {
      await this.unlock('read')
      await this.unlock('write')
      return
    }
    if (!this.count[type]) return
    await this._removeJob(type)
    this._count[type] = 0
  }

  unlockSync(type?: RWLockType): void {
    if (!type) {
      this.unlockSync('write')
      this.unlockSync('read')
      return
    }
    if (!this.count[type]) return
    this._debugReport('unlockSync', type)
    this._removeJobSync(type)
    this._count[type] = 0
  }

  @lockfile('internal')
  async check(type: RWLockType): Promise<Status> {
    const f = await this._fetchFile()
    const status = this._statusFromFile(type, f)
    if (status.status === 'open') return status
    else if (status.status === 'write_lock') {
      if (!await isActive(status.job.pid)) {
        this.debug(`removing inactive write pid: ${status.job.pid}`)
        delete f.writer
        await this.writeFile(f)
        return this.check(type)
      }
      return status
    } else if (status.status === 'read_lock') {
      const pids = await Promise.all(
        status.jobs.map(async j => {
          if (!await isActive(j.pid)) return j.pid
        }),
      )
      const inactive = pids.filter(p => !!p)
      if (inactive.length) {
        this.debug(`removing inactive read pids: ${inactive}`)
        f.readers = f.readers.filter(j => !inactive.includes(j.pid))
        await this.writeFile(f)
        return this.check(type)
      }
      if (!status.jobs.find(j => j.uuid !== this.uuid)) return { status: 'open', file: this.file }
      return status
    } else throw new Error(`Unexpected status: ${status!.status}`)
  }

  @lockfile('internal', { sync: true })
  checkSync(type: RWLockType): Status {
    const f = this._fetchFileSync()
    const status = this._statusFromFile(type, f)
    if (status.status === 'open') return status
    else if (status.status === 'write_lock') {
      if (!isActiveSync(status.job.pid)) {
        this.debug(`removing inactive writer pid: ${status.job.pid}`)
        delete f.writer
        this.writeFileSync(f)
        return this.checkSync(type)
      }
      return status
    } else if (status.status === 'read_lock') {
      const inactive = status.jobs.map(j => j.pid).filter(pid => !isActiveSync(pid))
      if (inactive.length) {
        this.debug(`removing inactive reader pids: ${inactive}`)
        f.readers = f.readers.filter(j => !inactive.includes(j.pid))
        this.writeFileSync(f)
        return this.checkSync(type)
      }
      if (!status.jobs.find(j => j.uuid !== this.uuid)) return { status: 'open', file: this.file }
      return status
    } else throw new Error(`Unexpected status: ${status!.status}`)
  }

  private _statusFromFile(type: RWLockType, f: RWLockfileJSON): Status {
    if (type === 'write' && this.count.write) return { status: 'open', file: this.file }
    if (type === 'read' && this.count.write) return { status: 'open', file: this.file }
    if (f.writer) return { status: 'write_lock', job: f.writer, file: this.file }
    if (type === 'write') {
      if (f.readers.length) return { status: 'read_lock', jobs: f.readers, file: this.file }
    }
    return { status: 'open', file: this.file }
  }

  private _parseFile(input: any): RWLockfileJSON {
    function addDate(job?: Job) {
      if (!job) return
      return {
        ...job,
        created: new Date(job.created || 0),
      }
    }

    return {
      ...input,
      writer: addDate(input.writer),
      readers: input.readers.map(addDate),
    }
  }

  private _stringifyFile(input: RWLockfileJSON): any {
    function addDate(job?: Job) {
      if (!job) return
      return {
        ...job,
        created: (job.created || new Date(0)).toISOString(),
      }
    }

    return {
      ...input,
      writer: addDate(input.writer),
      readers: (input.readers || []).map(addDate),
    }
  }

  private async _fetchFile(): Promise<RWLockfileJSON> {
    try {
      let f = await this.fs.readJSON(this.file)
      return this._parseFile(f)
    } catch (err) {
      if (err.code !== 'ENOENT') this.debug(err)
      return {
        version,
        readers: [],
      }
    }
  }

  private _fetchFileSync(): RWLockfileJSON {
    try {
      let f = this.fs.readJSONSync(this.file)
      return this._parseFile(f)
    } catch (err) {
      if (err.code !== 'ENOENT') this.debug(err)
      return {
        version,
        readers: [],
      }
    }
  }

  private addJob(type: RWLockType, reason: string | undefined, f: RWLockfileJSON): void {
    let job: Job = {
      reason,
      pid: process.pid,
      created: new Date(),
      uuid: this.uuid,
    }
    if (type === 'read') f.readers.push(job)
    else f.writer = job
  }

  @onceAtATime(0)
  @lockfile('internal')
  private async _removeJob(type: RWLockType): Promise<void> {
    let f = await this._fetchFile()
    this._removeJobFromFile(type, f)
    await this.writeFile(f)
  }

  @lockfile('internal', { sync: true })
  private _removeJobSync(type: RWLockType): void {
    let f = this._fetchFileSync()
    this._removeJobFromFile(type, f)
    this.writeFileSync(f)
  }

  private _removeJobFromFile(type: RWLockType, f: RWLockfileJSON): void {
    if (type === 'read') f.readers = f.readers.filter(r => r.uuid !== this.uuid)
    else if (f.writer && f.writer.uuid === this.uuid) delete f.writer
  }

  @onceAtATime(0)
  private async _lock(type: RWLockType, opts: RWLockOptions): Promise<void> {
    opts.timeout = opts.timeout || this.timeout
    opts.retryInterval = opts.retryInterval || this.retryInterval
    let ifLockedCb = once<IfLockedFn>(opts.ifLocked || this.ifLocked)
    while (true) {
      try {
        await this.tryLock(type, opts.reason, false)
        return
      } catch (err) {
        if (err.code !== 'ELOCK') throw err
        await ifLockedCb(err.status)
        if (opts.timeout < 0) throw err

        // try again
        const interval = random(opts.retryInterval / 2, opts.retryInterval * 2)
        await wait(interval)
        opts.timeout -= interval
        opts.retryInterval *= 2
      }
    }
  }

  @lockfile('internal')
  async tryLock(type: RWLockType, reason?: string, inc = true): Promise<void> {
    if (this.count[type]) {
      if (inc) this._count[type]++
      return
    }
    this.debug('tryLock', type, reason)
    const status = await this.check(type)
    if (status.status !== 'open') {
      this.debug('status: %o', status)
      throw new RWLockfileError(status)
    }
    let f = await this._fetchFile()
    this.addJob(type, reason, f)
    await this.writeFile(f)
    if (inc) this._count[type]++
    this.debug('got %s lock for %s', type, reason)
  }

  @lockfile('internal', { sync: true })
  private _lockSync(type: RWLockType, reason?: string): void {
    if (this._count[type]) {
      this._count[type]++
      return
    }
    const status = this.checkSync(type)
    if (status.status !== 'open') {
      this.debug('status: %o', status)
      throw new RWLockfileError(status)
    }
    let f = this._fetchFileSync()
    this.addJob(type, reason, f)
    this.writeFileSync(f)
    this._count[type]++
    this.debug('got %s lock for %s', type, reason)
  }

  private async writeFile(f: RWLockfileJSON): Promise<void> {
    if (!f.writer && !f.readers.length) {
      await this.fs.remove(this.file)
    } else {
      await this.fs.outputJSON(this.file, this._stringifyFile(f))
    }
  }

  private writeFileSync(f: RWLockfileJSON): void {
    if (!f.writer && !f.readers.length) {
      try {
        this.fs.unlinkSync(this.file)
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    } else {
      this.fs.outputJSONSync(this.file, this._stringifyFile(f))
    }
  }

  private get debug() {
    return this._debug || ((..._: any[]) => {})
  }
  private _debugReport(
    action: 'add' | 'addSync' | 'remove' | 'removeSync' | 'unlock' | 'unlockSync',
    type: RWLockType,
    { reason }: { reason?: string } = {},
  ): void {
    const operator =
      (action.startsWith('unlock') && `-${this.count[type]}`) || (action.startsWith('remove') && '-1') || '+1'
    const read = this.count['read'] + (type === 'read' ? operator : '')
    const write = this.count['write'] + (type === 'write' ? operator : '')
    reason = reason ? ` reason:${reason}` : ''
    this.debug(`read:${read} write:${write}${reason} ${this.file}`)
  }
}

const instances: RWLockfile[] = []
process.once('exit', () => {
  for (let i of instances) {
    try {
      i.unlockSync()
    } catch (err) {}
  }
})

function debugEnvVar(): number {
  return (
    ((process.env.RWLOCKFILE_DEBUG === '1' || process.env.HEROKU_DEBUG_ALL) && 1) ||
    (process.env.RWLOCKFILE_DEBUG === '2' && 2) ||
    0
  )
}

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function random(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min) + min)
}

function once<T extends (...args: any[]) => any>(fn: T): T {
  let ran = false
  return ((...args: any[]) => {
    if (ran) return
    ran = true
    return fn(...args)
  }) as any
}

async function isActive(pid: number) {
  try {
    return await isProcessActive.isActive(pid)
  } catch (err) {
    console.error(err)
    return false
  }
}
function isActiveSync(pid: number) {
  try {
    return isProcessActive.isActiveSync(pid)
  } catch (err) {
    console.error(err)
    return false
  }
}

export default RWLockfile
