const kappa = require('kappa-core')
const debug = require('debug')('kappa-drive')
const KV = require('kappa-view-kv')
const memdb = require('memdb')
const corestore = require('corestore')
const MountableHypertrie = require('mountable-hypertrie')
const hyperdrive = require('hyperdrive')
const duplexify = require('duplexify')
const ram = require('random-access-memory')
const path = require('path')
const through = require('through2')
const collect = require('collect-stream')
const crypto = require('hypercore-crypto')

const STATE = 'state'
const METADATA = 'metadata'
const CONTENT = 'content'

function dumbMerge (values) {
  return values[0]
}

const fileDescriptors = memdb()

module.exports = (storage, key, opts) => new KappaDrive(storage, key, opts)

class KappaDrive {
  constructor (storage, key, opts) {
    if (!Buffer.isBuffer(key) && !opts) {
      opts = key
      key = null
    }
    if (!opts) opts = {}

    this._id = opts._id || crypto.randomBytes(16)
    this._storage = storage
    this._index = opts.index || memdb()
    this._resolveFork = opts.resolveFork || dumbMerge
    this._opts = opts

    this.core = kappa(storage, Object.assign({ key }, this._opts))

    this.kvidx = KV(this._index, function (msg, next) {
      var ops = []
      var msgId = msg.key + '@' + msg.seq

      try { var value = JSON.parse(msg.value.toString()) }
      catch (err) { return next() }

      ops.push({
        key: value.filename,
        id: msgId,
        metadata: value.metadata,
        content: value.content,
        links: value.links || []
      })
      next(null, ops)
    })
    this.core.use('kv', this.kvidx)
  }

  get key () {
    return this.core._logs._fake.key
  }

  get discoveryKey () {
    return this.core._logs._fake.discoveryKey
  }

  replicate () {
    return this.core.replicate()
  }

  ready (cb) {
    if (this._isOpen) return cb()
    this._open(cb)
  }

  open (filename, flags, cb) {
    this._whoHasFile(filename, (err, drive) => {
      drive.open(filename, flags, (err, fd) => {
        if (err) return cb (err)
        fileDescriptors.put(fd, filename, (err) => {
          if (err) return cb(err)
          cb(null, fd)
        })
      })
    })
  }

  symlink (target, path, cb) {
    this._whoHasFile(target, (err, drive) => {
      drive.symlink(target, path, cb)
    })
  }

  unlink (target, cb) {
    this._whoHasFile(target, (err, drive) => {
      drive.unlink(target, cb)
    })
  }

  stat (filename, opts, cb) {
    this._whoHasFile(filename, (err, drive) => {
      drive.stat(filename, opts, cb)
    })
  }

  lstat (filename, opts, cb) {
    this._whoHasFile(filename, (err, drive) => {
      drive.lstat(filename, opts, cb)
    })
  }

  exists (filename, opts, cb) {
    this._whoHasFile(filename, (err, drive) => {
      drive.exists(filename, opts, cb)
    })
  }

  // is this right?  mkdir is a write operation
  mkdir (name, opts, cb) {
    this._whoHasFile(name, (err, drive) => {
      drive.mkdir(name, opts, cb)
    })
  }
  // i would suggest something more like this (although i dont know how hyperdrive handles directories)
  // mkdir (name, opts, cb) {
  //   this._getLinks(name, (err, links) => {
  //     if (err) return cb(err)
  //     this.drive.mkdir(name, data, (err) => {
  //       if (err) return cb(err)
  //       this._finishWrite(name, links, cb)
  //     })
  //   })
  // }

  readFile (filename, opts, cb) {
    if (!this._isOpen) throw new Error('not ready yet, try calling .ready')
    this._whoHasFile(filename, (err, drive) => {
      if (err) return cb(err)
      drive.readFile(filename, opts, cb)
    })
  }

  read (fd, buf, offset, len, position, cb) {
    fileDescriptors.get(fd, (err, filename) => {
      if (err) return cb(err)
      this._whoHasFile(filename, (err, drive) => {
        if (err) return cb(err)
        drive.read(fd, buf, offset, len, position, cb)
      })
    })
  }

  createReadStream (filename) {
    var proxy = duplexify()
    this._whoHasFile(filename, (err, drive) => {
      if (err) return proxy.emit('err', err)
      proxy.setReadable(drive.createReadStream(filename))
    })
    return proxy
  }

  readdir (name, opts, cb) {
    if (typeof opts === 'function') return this.readdir(name, null, opts)

    this._readdirRoot(opts, (err, fullDirList) => {
      if (err) return cb(err)
      if (name === '/') return cb(null, fullDirList)
      cb(null, fullDirList.filter((filePath) => {
        return (filePath.slice(0, name.length) === name)
      }))
    })
  }

  writeFile (filename, data, cb) {
    this._getLinks(filename, (err, links) => {
      if (err) return cb(err)
      this.drive.writeFile(filename, data, (err) => {
        if (err) return cb(err)
        this._finishWrite(filename, links, cb)
      })
    })
  }

  createWriteStream (filename) {
    var proxy = duplexify()
    this._getLinks(filename, (err, links) => {
      if (err) proxy.emit('error', err)
      var writer = this.drive.createWriteStream(filename)
      proxy.setWritable(writer)

      var prefinish = () => {
        proxy.cork()
        this._finishWrite(filename, links, (err) => {
          if (err) return proxy.destroy()
          proxy.uncork()
        })
      }

      proxy.on('close', done)
      proxy.on('finish', done)
      proxy.on('prefinish', prefinish)

      function done () {
        proxy.removeListener('close', done)
        proxy.removeListener('finish', done)
        proxy.removeListener('prefinish', prefinish)
      }
    })

    return proxy
  }

  truncate (filename, size, cb) {
    this._whoHasFile(filename, (err, drive) => {
      if (err) return cb(err)
      drive.truncate(filename, size, cb)
    })
  }

  // ------------------------------------------------------------

  _open (cb) {
    var self = this

    this.core.writer(STATE, (err, state) => {
      if (err) return cb(err)
      self.state = state
      self.core.writer(METADATA, (err, metadata) => {
        if (err) return cb(err)
        self.metadata = metadata
        self.core.writer(CONTENT, (err, content) => {
          if (err) return cb(err)
          self.content = content
          self._getDrive(metadata, content, (err, drive) => {
            debug(`${self._id} [INIT] local keys:\n${[metadata, content, state].map((f) => f.key.toString('hex')).join('\n')}`)
            if (err) return cb(err)
            self.drive = drive
            self._isOpen = true
            if (cb) cb()
          })
        })
      })
    })
  }

  _getDrive (metadata, content, cb) {
    var store = corestore(this.storage, { defaultCore: metadata })

    var drive = hyperdrive(ram, metadata.key, {
      corestore,
      metadata,
      _content: content,
      _db: new MountableHypertrie(store, metadata.key, {
        feed: metadata,
        sparse: this.sparseMetadata
      })
    })

    drive.ready(() => cb(null, drive))
  }

  _whoHasFile (filename, cb) {
    this.core.ready('kv', () => {
      this.core.api.kv.get(filename, (err, msgs = []) => {
        if (err && !err.notFound) return cb(err)
        var values = msgs.map(msg => JSON.parse(msg.value.toString()))
        if (!values || !values.length) return cb(null, this.drive)
        var winner = this._resolveFork(values)
        var metadata = this.core.feed(winner.metadata)
        debug(`[INDEX] metadata key: ${metadata}`)
        if (!metadata) return cb(new Error('invalid key for metadata'))
        var content = this.core.feed(winner.content)
        debug(`[INDEX] content key: ${content}`)
        if (!content) return cb(new Error('invalid key for content'))
        this._getDrive(metadata, content, cb)
      })
    })
  }

  _readdirRoot (opts, cb) {
    var self = this
    this.core.ready('kv', () => {
      var fileStream = this.core.api.kv.createReadStream()
      var throughStream = fileStream.pipe(through.obj(function (chunk, enc, next) {
        self.exists(chunk.key, opts, (exists) => {
          if (exists) this.push({ filename: chunk.key })
          next()
        })
      }))
      collect(throughStream, (err, data) => {
        if (err) return cb(err)
        cb(null, data.map(d => d.filename))
      })
    })
  }


  _getLinks (filename, cb) {
    this.core.ready('kv', () => {
      this.core.api.kv.get(filename, (err, msgs) => {
        if (err && !err.notFound) return cb(err)
        var links = msgs ? msgs.map((v) => v.key + '@' + v.seq) : []
        return cb(null, links)
      })
    })
  }

  _finishWrite (filename, links, cb) {
    // TODO: we probably should record the seq of the metadata/content as well
    // and perform a checkout to that hyperdrive seq on reads
    let metadata = this.metadata.key.toString('hex')
    let content = this.content.key.toString('hex')

    var res = {
      filename,
      links,
      metadata,
      content,
    }

    debug(`${this._id} [WRITE] writing latest file system state\n${JSON.stringify(res)}`)

    // TODO: ew JSON stringify is slow... lets use protobuf instead
    this.state.append(JSON.stringify(res), cb)
  }
}
