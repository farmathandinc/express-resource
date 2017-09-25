
/*!
 * Express - Resource
 * Copyright(c) 2010-2012 TJ Holowaychuk <tj@vision-media.ca>
 * Copyright(c) 2011 Daniel Gasienica <daniel@gasienica.ch>
 * MIT Licensed
 */

/**
 * Module dependencies.
 */

const methods = require( 'methods' );
const Promise = require( 'bluebird' );
const debug = require( 'debug' )( 'express-resource' );
const en = require( 'lingo' ).en;

/**
 * Pre-defined action ordering.
 */

var orderedActions = [
    'index'    //  GET   /
  , 'new'     //  GET   /new
  , 'create'  //  POST  /
  , 'show'    //  GET   /:id
  , 'edit'    //  GET   /edit/:id
  , 'update'  //  PUT   /:id
  , 'patch'   //  PATCH /:id
  , 'destroy' //  DELETE   /:id
];

/**
 * Expose `app`.
 */

exports = module.exports = function(app) {
  app.resource = resource.bind(app);
  app.resources = {};
  return app;
};

/**
 * Define a resource with the given `name` and `actions`.
 *
 * @param {String|Object} name or actions
 * @param {Object} actions
 * @return {Resource}
 * @api public
 */
function resource(name, actions, opts){
  if ('object' === typeof name) {
    actions = name;
    name = null;
  }
  if (!actions) return this.resources[name] || new Resource(name, null, this);
  for (var key in opts) actions[key] = opts[key];
  var res = this.resources[name] = new Resource(name, actions, this);
  return res;
}

/**
 * Initialize a new `Resource` with the given `name` and `actions`.
 *
 * @param {String} name
 * @param {Object} actions
 * @param {Server} app
 * @api private
 */

exports.Resource = Resource;

const trailingSlashIt = path =>
	'/' !== path[ path.length -1 ]
		? path + '/'
		: path;

const figureOutBase = providedValue => {
	if ( ! providedValue ) {
		return '/';
	} else {
		trailingSlashIt( providedValue );
	}
}

function Resource(name, actions, app) {
	if ( ! actions ) return;

	//might have to remove leading slash
	this.name = name;
	this.routes = {};
	this.app = app;
	this.base = figureOutBase( actions.base );
	this.format = actions.format;
	this.id = actions.id || this.defaultId;
	this.param = ':' + this.id;

	// default actions
	orderedActions.forEach( actionName => {
		if (
			actions[ actionName ]
			&& (
				! actions.only
				|| actions.only.includes( actionName )
			)
		) {
			this.mapDefaultAction(
				actionName,
				actions[ actionName ],
				actions
			);
		}
	} );

	actions.customActions.forEach( ( [ httpVerb, actionName, ] ) => this[ httpVerb ](
		actionName, // action name is used as the sub-path. i.e. /fields/:Field/plow -> FieldsController#plow
		hookUpActionMethod( actions[ actionName ], actions )
	) );

	// auto-loader
	if ( actions.load ) this.load( actions.load );
}

/**
 * Set the auto-load `fn`.
 *
 * @param {Function} fn
 * @return {Resource} for chaining
 * @api public
 */

Resource.prototype.load = function(fn){
  var self = this
    , id = this.id;

  this.loadFunction = fn;
  this.app.param(this.id, function(req, res, next){
    function callback(err, obj){
      if (err) return next(err);
      // TODO: ideally we should next() passed the
      // route handler
      if (typeof obj === 'undefined') return res.send(404);
      req[id] = obj;
      next();
    }

    // Maintain backward compatibility
    if (2 === fn.length) {
      fn(req.params[id], callback);
    } else {
      fn(req, req.params[id], callback);
    }
  });

  return this;
};

/**
 * Retun this resource's default id string.
 *
 * @return {String}
 * @api private
 */

Resource.prototype.__defineGetter__( 'defaultId', function() {
  return this.name
    ? en.singularize( this.name.split( '/' ).pop() )
    : 'id';
} );

Resource.prototype.prepareRoute = function( path ) {
	if ( '/' === path[0] ) { // if there is a leading slash, remove it
		path = path.substr( 1 );
	} else { // if there is not a leading slash
		if ( path ) { // - if there is a sub-path provided, prefix it with e.g. ':activity/'
			path = this.param + '/' + path;
		} else { // if there is not a sub-path provided sub-path is e.g. ':activity'
			path = this.param;
		}
	}

	// setup route pathname
	return `${ this.base }${ this.name || '' }${ this.name && path ? '/' : '' }${ path }.:format?`;
};

/**
 * Map http `httpVerb` and optional `path` to `action`.
 *
 * @param {String} httpVerb
 * @param {String|Function|Object} path
 * @param {Function} action
 * @return {Resource} for chaining
 * @api public
 */

Resource.prototype.map = function( httpVerb, path, action ){
  if ( httpVerb instanceof Resource ) return this.add( httpVerb );

  var self = this
    , orig = path;

  if (
	  'function' === typeof path
	  || 'object' === typeof path
  ) {
    action = path;
    path = '';
  }

  const route = this.prepareRoute( path );

  httpVerb = httpVerb.toLowerCase();


  // register the route so we may later remove it
  (this.routes[httpVerb] = this.routes[httpVerb] || {})[route] = {
      httpVerb,
    , path: route
    , orig,
    , action
  };

  // apply the route
  this.app[httpVerb]( route, function(req, res, next){
    req.format = req.params.format || req.format || self.format;
    if (req.format) res.type(req.format);
    if ('object' === typeof action) {
      if (action[req.format]) {
        action[req.format](req, res, next);
      } else {
        res.format(action);
      }
    } else {
      action(req, res, next);
    }
  });

  return this;
};

/**
 * Nest the given `resource`.
 *
 * @param {Resource} resource
 * @return {Resource} for chaining
 * @see Resource#map()
 * @api public
 */

Resource.prototype.add = function(resource){
  var app = this.app
    , routes
    , route;

  // relative base
  resource.base = this.base
    + (this.name ? this.name + '/': '')
    + this.param + '/';

  // re-define previous actions
  for (var httpVerb in resource.routes) {
    routes = resource.routes[httpVerb];
    for (var key in routes) {
      route = routes[key];
      delete routes[key];
      if (httpVerb === 'destroy') httpVerb = 'delete';
      // TODO: implement `router` or `app._router.stack` here
      /*
      app.routes[httpVerb].forEach(function(route, i){
        if (route.path === key) {
          app.routes[httpVerb].splice(i, 1);
        }
      })
      */
      resource.map(route.httpVerb, route.orig, route.action);
    }
  }

  return this;
};

const hookUpActionMethod = ( action, resource ) => {
	action = action.bind( resource );

	return ( req, res, next ) => {
		const stack = [];

		if (
			!!resource.middlewares
			&& !!resource.middlewares.length
		) {
			stack.push( Promise.map(
				resource.middlewares,
				middleware => middleware( req, res, next )
			) );
		}

		stack.push( action( req, res, next ) );

		return stack;
	};
};

/**
 * Map the given action `name` with a callback `action()`.
 *
 * @param {String} actionName
 * @param {Function} action
 * @api private
 */

Resource.prototype.mapDefaultAction = function( actionName, action, resource ) {
  const hookedUpActionMethod = hookUpActionMethod( action, resource );

  switch ( actionName ) {
    case 'index':
      this.get( '/', hookedUpActionMethod );
      break;
    case 'new':
      this.get( '/new', hookedUpActionMethod );
      break;
    case 'create':
      this.post( '/', hookedUpActionMethod );
      break;
    case 'show':
      this.get( hookedUpActionMethod );
      break;
    case 'edit':
      this.get( 'edit', hookedUpActionMethod );
      break;
    case 'update':
      this.put( hookedUpActionMethod );
      break;
    case 'patch':
      this.patch( hookedUpActionMethod );
      break;
    case 'destroy':
      this.delete( hookedUpActionMethod );
      break;
  }
};

/**
 * Setup http verb methods.
 */

methods
.concat( [ 'all', ] )
.forEach( httpVerb => {
	Resource.prototype[ httpVerb ] = ( path, action ) => {
		if (
			'function' === typeof path
			|| 'object' === typeof path
		) {
			action = path;
			path = '';
		}

		this.map( httpVerb, path, action );
		return this;
	}
} );
