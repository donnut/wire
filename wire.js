/**
 * @license Copyright (c) 2010 Brian Cavalier
 * LICENSE: see the LICENSE.txt file. If file is missing, this file is subject
 * to the MIT License at: http://www.opensource.org/licenses/mit-license.php.
 */

//
// TODO:
// - Allow easier loading of modules that don't actually need to be references, like dijits that
//    might be used for data-dojo-type
// - It's easy to forget the "create" property which triggers calling a module as a constructor.  Need better syntax, or
//    maybe create should be the default?
// - "destroy" property similar to init, that specifies what function to call on an object when its context is
//    destroyed.
//
(function(global, undef){
	"use strict";

	var VERSION = "0.1",
		wirePrefix = 'wire$',
		tos = Object.prototype.toString,
		arrt = '[object Array]',
		doc = document,
		head = doc.getElementsByTagName('head')[0],
		scripts = doc.getElementsByTagName('script'),
		// Hook up to require
		loadModules = window['require'],
		getLoadedModule = loadModules, // this may be requirejs specific
		onDomReady = loadModules.ready, // this is requirejs specific
		rootSpec = global.wire || {},
		defaultModules = ['wire/base'],
		rootContext;
		
	function isArray(it) {
		return tos.call(it) === '[object Array]';
	}
	
	function isFunction(it) {
		return typeof it == 'function';
	}
	
	function keys(obj) {
		var k = [];
		for(var p in obj) {
			if(obj.hasOwnProperty(p)) {
				k.push(p);
			}
		}
		
		return k;
	}

	function mixin(dst, src) {
		for(var p in src) {
			dst[p] = src[p];
		}

		return dst;
	}
	
	// function isModule(spec) {
	// 	return spec.module;
	// }
	// 
	function getModule(spec) {
		return spec.create
			? (typeof spec.create == 'string' ? spec.create : spec.create.module)
			: spec.module;
	}
	
	function isRef(spec) {
		return spec && spec.$ref !== undef;
	}
	
	var F = function F(ctor, args) {
			return ctor.apply(this, args);
		};

	function instantiate(ctor, args) {
		F.prototype = ctor.prototype;
		F.prototype.constructor = ctor;
		return new F(ctor, args);
	}
	
		
	function createResolver(remaining, object, prop, promise) {
		return function resolver(result) {
			object[prop] = result;
			if(remaining == 0) {
				promise.resolve(object);
			}
		};
	}
	
	var Promise = function() {
		this.completed = 0;
		this.chain = [];
	};
	
	Promise.prototype = {
		
		promise: function() {
			var self = this;
			return {
				then: function(resolved, rejected) {
					self.then(resolved, rejected);
				}
			};
		},
		
		then: function(resolved, rejected, progress) {
			var completed = this.completed,
				result = this.result;
				
			if(completed > 0) {
				if(resolved) resolved(result);
				
			} else if(completed < 0) {
				if(rejected) rejected(result);
				
			} else {
				this.chain.push({ resolve: resolved, reject: rejected, progress: progress });

			}

			return this;
		},
		
		resolve: function(value) {
			return this.complete(value, 1);
		},
		
		reject: function(value) {
			return this.complete(value, -1);
		},
		
		complete: function(value, completeType) {
			if(this.completed) throw Error("Promise already completed");
			
			this.completed = completeType;
			var action = completeType > 0 ? 'resolve' : 'reject',
				res = this.result = value,
				chain = this.chain,
				self = this,
				newResult;
		
			for(var i=0; i<chain.length; i++) {
				try {
					var c = chain[i],
						func = c[action];
						
					if(isFunction(func)) {
						newResult = func(res);
						
						if(newResult !== undef) {
							res = newResult;
						}
					}
				} catch(e) {
					// console.log("Promise ERROR", e, this);
					res = e;
					this.completed = -1;
					action = 'reject';
				}
			}
			
			return this.result;
		},
		
		progress: function(statusObject) {
			var chain = this.chain;
			for(var i=0; i<chain.length; i++) {
				try {
					var c = chain[i];
					if(c.progress) {
						c.progress(statusObject);
					}
				} catch(e) {
					this.reject(e);
				}
			}
		}
	};
	
	function reject(promise) {
		return function(err) {
			promise.reject(err);
		};
	}

	var ContextFactory = function(parent) {
		this.parent = parent;
		var uniques = this.uniqueModuleNames = {};
		for(var i=0; i<defaultModules.length; i++) {
			uniques[defaultModules[i]] = 1;
		}
		this.modulesReady = new Promise();
		this.objectsCreated = new Promise();
		this.objectsReady = new Promise();
		this.contextReady = new Promise();
		this.contextDestroyed = new Promise();
		this.domReady = new Promise();

		this.context = {};
		
		this.setters = [];
		this.resolvers = {};
		this.listeners = {
			onContextInit: [],
			onContextError: [],
			onContextReady: [],
			onContextDestroy: [],
			onCreate: [],
			onProperties: [],
			onInit: [],
			onDestroy: []
		};
		this.destroyers = [];
		this.objectsToCreate = 0;
		this.objectCreateCount = 0;
		this.objectsToInit = 0;
		this.objectInitCount = 0;
		
		var self = this;
		this.pluginProxy = {
			modulesReady: this.modulesReady.promise(),
			objectsCreated: this.objectsCreated.promise(),
			objectsReady: this.objectsReady.promise(),
			contextReady: this.contextReady.promise(),
			domReady: this.domReady.promise(),
			contextDestroyed: this.contextDestroyed.promise(),
			resolveName: function(name) {
				return self.context[name];
			},
			resolveRef: function(ref) {
				return self.resolveRef(ref);
			},
			setProperties: function(object, props) {
				return self.setProperties(object, props);
			}
		};
	};
	
	ContextFactory.prototype = {

		resolveRefObj: function(refObj, promise) {
			var ref = refObj.$ref,
				resolvers = this.resolvers,
				parent = this.parent,
				self = this,
				prefix = "_",
				name = ref;

			if(ref.indexOf("!") >= 0) {
				var parts = ref.split("!");
				prefix = parts[0];
			    name = parts[1];
			}
			
			var promiseProxy = {
				resolve: function resolvePromise(resolved) {
					promise.resolve(resolved);
				}
			};
			
			promiseProxy.unresolved = (parent)
				? function tryParent() {
					parent.resolveRefObj(refObj, promise);
				}
				: function rejectPromise() {
					promise.reject("Can't resolve reference " + name);
				};
			
			if(resolvers[prefix]) {
				resolvers[prefix](this.pluginProxy, name, refObj, promiseProxy);
				
			} else {
				promiseProxy.unresolved();
				
			}
		},

		resolveRef: function(ref) {
			// console.log("Trying to resolve", ref);
			var p = new Promise(),
				self = this;
				
			if(isRef(ref)) {
				this.modulesReady.then(function resolveRefAfterModulesReady() {
					self.resolveRefObj(ref, p);
				});
			} else {
				p.resolve(ref);
			}
			return p;
		},
		
		createObject: function(spec, module) {
			var p = new Promise(),
				object = module,
				objectsCreated = this.objectsCreated,
				self = this;

			function objectCreated(obj, promise) {
				self.modulesReady.then(function handleModulesReady() {
					objectsCreated.progress({ object: obj, spec: spec });
					promise.resolve(obj);
				});
			}
			
			try {
				if(spec.create && isFunction(module)) {
					var args = [];
					if(typeof spec.create == 'object' && spec.create.args) {
						args = isArray(spec.create.args) ? spec.create.args : [spec.create.args];
					}
					// var args = isArray(spec.create) ? spec.create : [spec.create];
					// console.log("createObject ", spec, args);
					this.parse(args).then(
						function handleCreateParsed(resolvedArgs) {
							objectCreated(instantiate(module, resolvedArgs), p);
						},
						reject(p)
					);
				} else {
					objectCreated(object, p);
				}
				
			} catch(e) {
				p.reject(e);
			}

			return p;
		},
		
		initObject: function(spec, object) {
			var promise = new Promise(),
				domReady = this.domReady,
				self = this;
				
			function resolveObjectInit() {
				if(spec.init) {
					self.processFuncList(spec.init, object, spec,
						function handleProcessFuncList(target, spec, func, args) {
							self.callInit(target, spec, func, args).then(
								function() {
									promise.resolve(object);
								}
							);
						}
					);
				} else {
					promise.resolve(object);
				}
			}
			
			if(spec.properties) {
				this.setProperties(object, spec.properties).then(
					resolveObjectInit,
					reject(promise)
				);
			} else {
				resolveObjectInit();
			}
			
			
			if(spec.destroy) {
				this.destroyers.push(function doDestroy() {
					self.processFuncList(spec.destroy, object, spec, function(target, spec, func, args) {
						func.apply(target, []); // no args for destroy
					});
				});
			}
			
			return promise;
		},
		
		callObjectInit: function(spec, object) {
			
		},
		
		
		setProperties: function(object, props) {
			var promise = new Promise(),
				keyArr = keys(props),
				self = this,
				setters = this.setters,
				cachedSetter;
			
			var count = keyArr.length;
			for(var i=0; i<keyArr.length; i++) {
				(function(remaining, name, prop) {
					self.parse(prop, undef).then(function handlePropertiesParsed(value) {
						// If we previously found a working setter for this target, use it
						if(!(cachedSetter && cachedSetter(object, name, value))) {
							var success = false,
								i = 0;
								// Try all the registered setters until we find one that reports success
							while(!success && i<setters.length) {
								var setter = setters[i++];
								success = setter(object, name, value);
								if(success) {
									cachedSetter = setter;
								}
							}
						}

						if(remaining === 0) {
							self.fireEvent('onProperties', object, props);
							promise.resolve(object);
						}
					}, reject(self.contextReady));
				})(--count, keyArr[i], props[keyArr[i]]);
			}
			
			return promise;
		},
		
		
		processFuncList: function(list, target, spec, callback) {
			var func;
			if(typeof list == "string") {
				func = target[list];
				if(isFunction(func)) {
					callback(target, spec, func, []);
				}
			} else {
				for(var f in list) {
					func = target[f];
					if(isFunction(func)) {
						callback(target, spec, func, list[f]);
					}
				}
			}
		},

		callInit: function(target, spec, func, args) {
			var self = this;
			return this.parse(args).then(function handleInitParsed(processedArgs) {
				func.apply(target, isArray(processedArgs) ? processedArgs : [processedArgs]);
				self.fireEvent('onInit', target, spec);
			});
		},

		loadModule: function(moduleId) {
			var p = new Promise(),
				uniques = this.uniqueModuleNames;
				// self = this;

			if(!uniques[moduleId]) {
				// console.log("Loading module", moduleId);
				uniques[moduleId] = 1;
				loadModules([moduleId], function handleModulesLoaded(module) {
					// console.log("Loaded module", moduleId);
					uniques[moduleId] = module;
					p.resolve(module);
				});
			} else {
				this.modulesReady.then(function handleModulesReady() {
					p.resolve(uniques[moduleId]);
				});
			}
			
			return p;
		},
		
		scanPlugins: function(modules) {
			// console.log("scanning for plugins", modules);
			var p = new Promise();
			
			var setters = [],
				resolvers = this.resolvers;

			for (var i=0; i < modules.length; i++) {
				var newPlugin = modules[i];
				// console.log("scanning for plugins: " + newPlugin);
				if(typeof newPlugin == 'object') {
					if(newPlugin.wire$resolvers) {
						for(var name in newPlugin.wire$resolvers) {
							resolvers[name] = newPlugin.wire$resolvers[name];
						}
					}

					if(newPlugin.wire$setters) {
						setters = newPlugin.wire$setters.concat(setters);
					}

					if(newPlugin.wire$listeners) {
						this.addEventListeners(newPlugin.wire$listeners);
					}

					if(isFunction(newPlugin.wire$init)) {
						// Have to init plugins immediately, so they can be used during wiring
						newPlugin.wire$init();
					}
				}
			}
			
			this.setters = setters;

			p.resolve(modules);
			return p;
		},
		
		addEventListeners: function(listener) {
			var listeners = this.listeners;
			for(var p in listeners) {
				if(isFunction(listener[p])) {
					listeners[p].push(listener);
				}
			}
		},

		fireEvent: function(/* name, arg1, arg2... */) {
			var args = Array.prototype.slice.call(arguments),
				name = args.shift(),
				pluginsToCall = this.listeners[name];

			for(var i=0; i<pluginsToCall.length; i++) {
				var plugin = pluginsToCall[i];
				plugin[name].apply(plugin, args);
			}
		},

		wire: function(spec) {
			var contextReady = this.contextReady,
				modulesReady = this.modulesReady,
				objectsCreated = this.objectsCreated,
				objectsReady = this.objectsReady,
				domReady = this.domReady,
				myContext = this.context,
				parent = this.parent,
				self = this,
				rejectPromise = function rejectAndFireEvent(promise, message, err) {
					self.fireEvent('onContextError', myContext, message, err);
					reject(promise);
				};

			onDomReady(function resolveDomReady() {
				// console.log('domReady');
				domReady.resolve();
			});

			modulesReady.then(
				function resolveModulesReady(modules) {
					self.fireEvent('onContextInit', modules);
				},
				function rejectModulesReady(err) {
					rejectPromise(objectsCreated, "Module loading failed", err);
				});
				
			objectsCreated.then(
				null,
				function rejectObjectsCreated(err) {
					rejectPromise(objectsReady, "Object creation failed", err);
				},
				function progressObjectsCreated(status) {
					self.fireEvent("onCreate", status.object, status.spec);
				}
			);

			contextReady.then(
				function resolveContextReady(context) {
					self.fireEvent('onContextReady', context);
				}
			);
			
			if(parent) {
				mixin(myContext, parent.context);
				parent.contextDestroyed.then(function handleParentDestroyed() { self.destroy(); });
			}
			
			try {
				this.parse(spec, myContext).then(
					function handleParsedContext(context) {
						context.wire = function wire(spec) {
							return new ContextFactory(self).wire(spec);
						};
						context.resolve = function resolve(ref) {
							return self.resolveName(ref).promise();
						};
						context.destroy = function destroy() {
							return self.destroy().promise();
						};

						if(self.objectsToCreate === 0) {
							objectsCreated.resolve(context);
						}
						
						if(self.objectsToInit === 0) {
							// objectsReady.resolve(context);
							contextReady.resolve(context);
						}

						// objectsReady.then(function finalizeContext(context) {
						// 	// It should be possible not to have to wait for domReady
						// 	// here, but rely on promise resolution.  For now, just wait
						// 	// for it.
						// 	domReady.then(function() {
						// 		contextReady.resolve(context);
						// 	})
						// });
					},
					reject(contextReady)
				);
				
				loadModules(keys(this.uniqueModuleNames), function handleModulesLoaded() {
					self.scanPlugins(arguments).then(function handlePluginsScanned(scanned) {
						modulesReady.resolve(scanned);
					});
				});

			} catch(e) {
				contextReady.reject(e);
			}

			return contextReady;
		},
		
		parse: function(spec, result) {
			var processed = spec,
				promise = new Promise(),
				self = this,
				count,
				len;

			if(isArray(spec)) {
				len = spec.length;
				if(len == 0) {
					promise.resolve(processed);
				}
				processed = result||[];

				var arrCount = len;
				for(var i=0; i<len; i++) {
					this.parse(spec[i]).then(
						createResolver(--arrCount, processed, i, promise),
						reject(promise));
				}

			} else if(typeof spec == 'object') {
				// module, reference, or simple object
				var moduleToLoad = getModule(spec);
				if(moduleToLoad) {
					self.objectsToCreate++;
					self.objectsToInit++;
					// Create object from module
					this.loadModule(moduleToLoad).then(
						function handleModuleLoaded(module) {
							self.createObject(spec, module).then(
								function handleObjectCreated(created) {
									promise.resolve(created);
									if(++self.objectCreateCount === self.objectsToCreate) {
										self.objectsCreated.resolve(self.context);
									}
									self.initObject(spec, created).then(
										function handleObjectInited(object) {
											if(++self.objectInitCount === self.objectsToInit) {
												self.domReady.then(function() {
													self.contextReady.resolve(self.context);
												});
											}
										});
								},
								reject(self.contextReady)
							);
						}
					);

				} else if(isRef(spec)) {
					// Resolve reference
					this.resolveRef(spec).then(
						function handleResolveRef(target) {
							promise[target === undef ? 'reject' : 'resolve'](target);
						},
						reject(promise)
					);

				} else {
					// Recurse on plain object properties
					processed = result||{};
					var props = keys(spec);

					len = props.length;
					if(len == 0) {
						promise.resolve(processed);
					} else {
						// console.log("resolving POJO", len, spec);
						var propCount = len;
						for(var j=0; j<len; j++) {
							var p = props[j];
							this.parse(spec[p]).then(
								createResolver(--propCount, processed, p, promise),
								reject(promise)
							);
						}
					}
				}
				
			} else {
				promise.resolve(processed);
			}

			return promise;
		},
		
		destroy: function() {
			var self = this;
						
			this.contextReady.then(
				function(context) {
					var destroyers = self.destroyers;
					for(var i=0; i<destroyers.length; i++) {
						destroyers[i]();
					}

					self.contextDestroyed.resolve();
					self.fireEvent('onContextDestroy', context);
				}
			);
			
			// if(!this.domReady.completed) {
			// 	this.domReady.reject("Context destroyed");
			// }
			return this.contextDestroyed;
		}
	};
	
	/*
		Function: wire
		Global wire function that is the starting point for wiring applications.
		
		Parameters:
			spec - wiring spec
			ready - Function to call with the newly wired Context
	*/
	var w = global['wire'] = function wire(spec) { // global['wire'] for closure compiler export
		var promise;
		if(rootContext === undef) {
			// No root context yet, so wire it first, then wire the requested spec as
			// a child.  Subsequent wire() calls will reuse the existing root context.
			promise = new Promise();
			
			new ContextFactory().wire(rootSpec).then(function(context) {
				rootContext = context;
				rootContext.wire(spec).then(
					function(context) {
						promise.resolve(context);
					},
					function(err) {
						promise.reject(err);
					}
				);
			});
		} else {
			promise = rootContext.wire(spec);
		}
		
		return promise.promise(); // Return restricted promise
	};
	
	w.version = VERSION;
	
	// WARNING: Probably unsafe. Just for testing right now.
	// TODO: Only do this for browser env
	
	// Find our script tag and look for data attrs
	for(var i=0; i<scripts.length; i++) {
		var script = scripts[i],
			src = script.src,
			specUrl;
		
		// if(/wire[^\/]*\.js(\W|$)/.test(src) && (specUrl = script.getAttribute('data-wire-spec'))) {
		if((specUrl = script.getAttribute('data-wire-spec'))) {
			// Use a script tag to load the wiring spec
			var specScript = doc.createElement('script');
			specScript.src = specUrl;
			head.appendChild(specScript);
		}
	}

})(window);
