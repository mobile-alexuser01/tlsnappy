var tlsnappy = require('../tlsnappy'),
    util = require('util'),
    net = require('net'),
    os = require('os'),
    http = require('http'),
    Duplex = require('stream').Duplex;

var DEFAULT_CIPHERS = 'ECDHE-RSA-AES128-SHA256:AES128-GCM-SHA256:' + // TLS 1.2
                      'RC4:HIGH:!MD5:!aNULL:!EDH';                   // TLS 1.0

// Convert protocols array into valid OpenSSL protocols list
// ("\x06spdy/2\x08http/1.1\x08http/1.0")
function convertNPNProtocols(NPNProtocols) {
  // If NPNProtocols is Array - translate it into buffer
  if (Array.isArray(NPNProtocols)) {
    var buff = new Buffer(NPNProtocols.reduce(function(p, c) {
      return p + 1 + Buffer.byteLength(c);
    }, 0));

    NPNProtocols.reduce(function(offset, c) {
      var clen = Buffer.byteLength(c);
      buff[offset] = clen;
      buff.write(c, offset + 1);

      return offset + 1 + clen;
    }, 0);

    NPNProtocols = buff;
  }

  // If it's already a Buffer - store it
  if (Buffer.isBuffer(NPNProtocols)) return NPNProtocols;
};

function Server(options, listener) {
  var self = this;

  net.Server.call(this, this.onconnection.bind(this));

  if (options.NPNProtocols) {
    var npn = convertNPNProtocols(options.NPNProtocols);
  }

  // Create workers
  this.options = options || {};
  this.contexts = [];
  this.current = 0;
  this.threads = options.threads || os.cpus().length;
  for (var i = 0; i < this.threads; i++) {
    var context = new tlsnappy.binding.Context();
    if (options.key) context.setKey(options.key);
    if (options.cert) context.setCert(options.cert);
    context.setCiphers(options.ciphers || DEFAULT_CIPHERS);
    if (npn) context.setNPN(npn);

    this.contexts.push(context);
  }

  if (listener) this.on('secureConnection', listener);
  this.on('close', function onclose() {
    self.threads = 0;
    self.contexts = [];
  });
};
util.inherits(Server, net.Server);
exports.TLSServer = Server;

exports.createTLSServer = function createTLSServer(options, listener) {
  return new Server(options, listener);
};

function HTTPServer(options, listener) {
  Server.call(this, options, http._connectionListener);

  if (listener) {
    this.addListener('request', listener);
  }
};
exports.Server = HTTPServer;
util.inherits(HTTPServer, Server);

exports.createServer = function createServer(options, listener) {
  return new HTTPServer(options, listener);
};

Server.prototype.onconnection = function onconnection(c) {
  var self = this,
      snappy = new Socket(c, this.contexts[this.current], this.options);

  // Round-robin contexts
  this.current = (this.current + 1) % this.threads;

  snappy.once('init', function oninit() {
    self.emit('secureConnection', snappy);
  });
};

function Socket(c, context, options) {
  Duplex.call(this);

  this.c = c;
  this.binding = new tlsnappy.binding.Socket(context);

  this._destroySoon = false;
  this._closed = false;
  this._initialized = false;
  this._handshakeTimeout = options.handshakeTimeout || 120 * 1000;
  this._handshakeTimer = null;
  this._shutdownTimeout = options.shutdownTimeout || 5000;
  this._shutdownTimer = null;
  this.npnProtocol = null;
  this.init(c);
};
util.inherits(Socket, Duplex);
exports.Socket = Socket;

// SlabBuffer from node.js
function SlabBuffer() {
  this.create();
};

SlabBuffer.prototype.create = function create() {
  this.isFull = false;
  this.pool = new Buffer(10 * 1024 * 1024);
  this.offset = 0;
  this.remaining = this.pool.length;
};

SlabBuffer.prototype.use = function use(context, fn) {
  if (this.remaining === 0) {
    this.isFull = true;
    return 0;
  }

  var bytes = fn.call(context, this.pool, this.offset, this.remaining);

  if (bytes > 0) {
    this.offset += bytes;
    this.remaining -= bytes;
  }

  return bytes;
};

var slabBuffer = new SlabBuffer();

// Binding methods
function oncycle() {
  // Write encrypted data to socket
  while (true) {
    var start = this._buffer.offset,
        bytesRead;

    bytesRead = this._buffer.use(this, this.encOut);
    if (bytesRead === 0) {
      // Try again if buffer was filled
      if (this._buffer.isFull) {
        this._buffer.create();
        continue;
      }

      // Otherwise there're nothing to read
      break;
    }

    this.c.write(this._buffer.pool.slice(start, start + bytesRead));
  }

  // Emit unencrypted (clear) data from binding
  var socket = this.socket;

  // Emit data only once initialized
  if (!socket._initialized) return;

  while (true) {
    var start = this._buffer.offset,
        bytesRead;

    bytesRead = this._buffer.use(this, this.clearOut);
    if (bytesRead === 0) {
      // Try again if buffer was filled
      if (this._buffer.isFull) {
        this._buffer.create();
        continue;
      }

      // Otherwise there're nothing to read
      break;
    }

    if (socket.ondata) {
      socket.ondata(this._buffer.pool, start, start + bytesRead);
    } else {
      var cdata = this._buffer.pool.slice(start, start + bytesRead);
      socket.push(cdata);
    }
  }
};

function onclose() {
  if (this.socket._destroySoon) {
    this.c.destroySoon();
  } else {
    this.c.destroy();
  }
  if (this.socket._shutdownTimer) {
    clearTimeout(this.socket._shutdownTimer);
    this.socket._shutdownTimer = null;
  }
  if (this.socket._handshakeTimer) {
    clearTimeout(this.socket._handshakeTimer);
    this.socket._handshakeTimer = null;
  }
  this.socket.push(null);
  this.socket.binding = null;
  this.socket._closed = true;
};

function oninit(npn) {
  this.socket._initialized = true;
  this.socket.npnProtocol = npn;
  this.socket.emit('init');
  if (this.socket._handshakeTimer) {
    clearTimeout(this.socket._handshakeTimer);
    this.socket._handshakeTimer = null;
  }

  // Binding expects us to call it
  oncycle.call(this);
};

Socket.prototype.init = function init(socket) {
  var self = this;

  this.binding.c = socket;
  this.binding.socket = this;
  this.binding._buffer = slabBuffer;
  this.binding.oncycle = oncycle;
  this.binding.onclose = onclose;
  this.binding.oninit = oninit;

  // Initialize socket
  socket.ondata = this.binding.encIn.bind(this.binding);
  function end() {
    self.end();
  }
  socket.on('close', end);
  socket.on('end', end);
  socket.on('error', end);
  socket.on('timeout', function onTimeout() {
    self.emit('timeout');
  });
  socket.resume();

  this._handshakeTimer = setTimeout(function handshakeTimer() {
    socket.destroy();
  }, this._handshakeTimeout);

  this.once('finish', function() {
    if (this._closed) return;
    this._closed = true;

    this.binding.close();

    this._shutdownTimer = setTimeout(function shutdownTimer() {
      self.binding.forceClose();
    }, this._shutdownTimeout);
  });

  this.once('end', function() {
    if (this.onend) this.onend();
  });
};

Socket.prototype.setTimeout = function setTimeout(ms, callback) {
  this.c.setTimeout(ms, callback);
};

Socket.prototype.destroySoon = function destroySoon() {
  if (this._closed) return;
  this._destroySoon = true;
  this.end();
};

Socket.prototype._read = function read() {
  // Ignore, really...
};

Socket.prototype._write = function write(data, enc, cb) {
  this.binding.clearIn(data);
  return cb(null);
};

Socket.prototype.destroy = function destroy() {
  this.end();
};

//
// `net` compatibility layer
// (Copy pasted from lib/tls.js from node.js)
//
Socket.prototype.address = function address() {
  return this.c && this.c.address();
};

Socket.prototype.__defineGetter__('remoteAddress', function remoteAddress() {
  return this.c && this.c.remoteAddress;
});

Socket.prototype.__defineGetter__('remotePort', function remotePort() {
  return this.c && this.c.remotePort;
});
