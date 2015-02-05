/**
 * Sandcrawler Scraper Abstraction
 * ================================
 *
 * Abstract scraper definition on which one should should mount an precise
 * engine to actually work.
 *
 * The intention here is to clearly separate the scraper's logic from its means.
 */
var EventEmitter = require('events').EventEmitter,
    types = require('typology'),
    util = require('util'),
    uuid = require('uuid'),
    async = require('async'),
    validate = require('./plugins/validate.js'),
    phscript = require('./phantom_script.js'),
    extend = require('./helpers.js').extend,
    defaults = require('../defaults.json').scraper;

/**
 * Main
 */
function Scraper(name) {
  var self = this;

  // Safeguard
  if (!(this instanceof Scraper))
    return new Scraper(name);

  // Events
  EventEmitter.call(this);

  // Assigning a unique identifer
  this.id = 'Scraper[' + uuid.v4() + ']';
  this.name = name || this.id.substr(0, 16) + ']';

  // Properties
  this.options = defaults;
  this.engine = null;
  this.type = null;
  this.state = {
    fulfilled: false,
    locked: false,
    paused: false,
    running: false
  };

  // Additional properties
  this.scriptStack = null;
  this.parser = Function.prototype;

  // Queue
  this.queue = async.queue(function(job, callback) {

    // Processing one job through the pipe
    return async.applyEachSeries([
      beforeScraping.bind(self),
      scrape.bind(self),
      afterScraping.bind(self)
    ], job, function(err) {

      if (err) {
        job.res.error = err;

        // Failing the job
        self.emit('job:fail', err, job);
      }
      else {

        // Calling it a success
        self.emit('job:success', job);
      }

      return callback(err, job);
    });

  }, this.options.maxConcurrency || 1);

  // Pausing so that the queue starts processing only when we want it
  this.queue.pause();

  // Middlewares
  this.middlewares = {
    before: [],
    after: [],
    beforeScraping: [],
    afterScraping: []
  };
}

// Inheriting
util.inherits(Scraper, EventEmitter);

/**
 * Helpers
 */

// Creating a job object from a feed
function createJob(feed) {

  // Job skeleton
  var job = {
    id: 'Job[' + uuid.v4() + ']',
    original: feed,
    state: {},
    req: {
      retries: 0,
      data: {},
      params: {}
    },
    res: {}
  };

  // Handling polymorphism
  if (types.get(feed) === 'string') {
    job.req.url = feed;
  }
  else {

    // Safeguard
    if (!feed.url)
      throw Error('sandcrawler.scraper.url(s)/addUrl(s): no url provided.');

    job.req.url = feed.url;
    job.req.data = feed.data || {};
    job.req.params = feed.params || {};

    if (feed.timeout)
      job.req.timeout = feed.timeout;
  }

  return job;
}

// Applying beforeScraping middlewares
function beforeScraping(job, callback) {
  return async.applyEachSeries(
    this.middlewares.beforeScraping,
    job.req,
    callback
  );
}

// Using the engine to scrape
function scrape(job, callback) {
  return this.engine.fetch(job, callback);
}

// Applying afterScraping middlewares
function afterScraping(job, callback) {
  return async.applyEachSeries(
    this.middlewares.afterScraping,
    job.req, job.res,
    callback
  );
}

/**
 * Prototype
 */

// Starting the scraper
Scraper.prototype.run = function(callback) {
  var self = this;

  // Emitting
  this.emit('scraper:start');

  // Resolving starting middlewares
  async.series(
    this.middlewares.before,
    function(err) {

      // Failing the scraper if error occurred
      if (err) {
        callback(err);
        return self.fail(err);
      }

      // Else, we simply resume the queue and wait for it to drain
      self.queue.drain = function() {

        // All processes finished, we call it a success
        callback(null);
        return self.succeed();
      };

      self.queue.resume();
    }
  );
};

// Failing the scraper
Scraper.prototype.fail = function(err) {
  this.emit('scraper:fail', err);
  this.exit('fail');
};

// Succeeding the scraper
Scraper.prototype.succeed = function() {
  this.emit('scraper:success');
  this.exit('success');
};

// Exiting the scraper
Scraper.prototype.exit = function(status) {

  // Emitting
  this.emit('scraper:end', status);

  // TODO: Resolving ending middlewares

  this.state.running = false;
  this.state.fulfilled = true;

  // Tearing down
  this.teardown();
};

// Teardown
Scraper.prototype.teardown = function() {

  // Emitting
  this.emit('scraper:teardown');

  // Ending jobStream
  this.queue.kill();

  // Listeners
  this.removeAllListeners();
};

// Assigning a single url
Scraper.prototype.url = function(feed) {

  // TODO: more precise type checking
  if (!types.check(feed, 'string|array|object'))
    throw Error('sandcrawler.scraper.url(s): wrong argument.');

  (!(feed instanceof Array) ? [feed] : feed).forEach(function(item) {
    this.queue.push(createJob(item));
  }, this);

  return this;
};

// Adding a new url during runtime
Scraper.prototype.addUrl = function(feed) {

  // TODO: more precise type checking
  if (!types.check(feed, 'string|array|object'))
    throw Error('sandcrawler.scraper.url(s): wrong argument.');

  (!(feed instanceof Array) ? [feed] : feed).forEach(function(item) {
    this.queue.push(createJob(item));
  }, this);

  this.emit('job:added');

  return this;
};

// Aliases
Scraper.prototype.urls = Scraper.prototype.url;
Scraper.prototype.addUrls = Scraper.prototype.addUrl;

// Iterating through a generator
Scraper.prototype.iterate = function(fn) {

  // TODO: possibility of multiple generators
};

// Loading the scraping script
Scraper.prototype.script = function(path, check) {
  if (this.scriptStack)
    throw Error('sandcrawler.scraper.script: script already registered.');

  this.scriptStack = phscript.fromFile(path, check);
  return this;
};

// Loading some jawascript
Scraper.prototype.jawascript = function(fn, check) {
  if (this.scriptStack)
    throw Error('sandcrawler.scraper.jawascript: script already registered.');

  if (typeof fn === 'function')
    this.scriptStack = phscript.fromFunction(fn, check);
  else if (typeof fn === 'string')
    this.scriptStack = phscript.fromString(fn, check);
  else
    throw Error('sandcrawler.scraper.jawascript: wrong argument.');

  return this;
};

// Parser used by static scenarios
Scraper.prototype.parse = function(fn) {

  if (typeof fn !== 'function')
    throw Error('sandcrawler.scraper.parse: given argument is not a function.');

  this.parser = fn;

  return this;
};

// Computing results of a job
Scraper.prototype.result = function(fn) {

  if (typeof fn !== 'function')
    throw Error('sandcrawler.scraper.result: given argument is not a function.');

  this.on('job:fail', function(err, job) {
    fn.call(this, err, job.req, job.res);
  });

  this.on('job:success', function(job) {
    fn.call(this, null, job.req, job.res);
  });

  return this;
};

// Altering configuration
Scraper.prototype.config = function(o) {

  if (!types.check(o, 'object'))
    throw Error('sandcrawler.scraper.config: wrong argument.');

  this.options = extend(o, this.options);
  return this;
};

// Updating timeout
Scraper.prototype.timeout = function(t) {

  if (!types.check(t, 'number'))
    throw Error('sandcrawler.scraper.timeout: wrong argument');

  this.options.timeout = t;

  return this;
};

// Using a plugin
Scraper.prototype.use = function(plugin) {

  if (typeof plugin !== 'function')
    throw Error('sandcrawler.scraper.use: plugin must be a function.');

  plugin.call(this, this);
  return this;
};

// Shortcut for the built-in validate plugin
Scraper.prototype.validate = function(definition) {
  return this.use(validate(definition));
};

// Registering middlewares
function middlewareRegister(type) {
  Scraper.prototype[type] = function(fn) {

    // Guard
    if (typeof fn !== 'function')
      throw Error('sandcrawler.scraper.' + type + ': given argument is not a function');

    this.middlewares[type].push(fn);
    return this;
  };
}

middlewareRegister('before');
middlewareRegister('after');
middlewareRegister('beforeScraping');
middlewareRegister('afterScraping');

/**
 * Exporting
 */
module.exports = Scraper;