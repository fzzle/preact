import { EMPTY_OBJ } from '../constants';
import { Component } from '../component';
import { Fragment } from '../create-element';
import { diffChildren } from './children';
import { setProperty } from './props';
import { assign, removeNode, slice } from '../util';
import options from '../options';

/**
 * Diff two virtual nodes and apply proper changes to the DOM
 * @param {import('../internal').PreactElement} parentDom The parent of the DOM element
 * @param {import('../internal').VNode} newVNode The new virtual node
 * @param {import('../internal').VNode} oldVNode The old virtual node
 * @param {object} globalContext The current context object. Modified by getChildContext
 * @param {boolean} isSvg Whether or not this element is an SVG node
 * @param {Array<import('../internal').PreactElement>} excessDomChildren
 * @param {Array<import('../internal').Component>} commitQueue List of components
 * which have callbacks to invoke in commitRoot
 * @param {import('../internal').PreactElement} oldDom The current attached DOM
 * element any new dom elements should be placed around. Likely `null` on first
 * render (except when hydrating). Can be a sibling DOM element when diffing
 * Fragments that have siblings. In most cases, it starts out as `oldChildren[0]._dom`.
 * @param {boolean} [isHydrating] Whether or not we are in hydration
 */
export function diff(
	parentDom,
	newVNode,
	oldVNode,
	globalContext,
	isSvg,
	excessDomChildren,
	commitQueue,
	oldDom,
	isHydrating
) {
	let tmp,
		newType = newVNode.type;

	// When passing through createElement it assigns the object
	// constructor as undefined. This to prevent JSON-injection.
	if (newVNode.constructor !== undefined) return;

	// If the previous diff bailed out, resume creating/hydrating.
	if (oldVNode._hydrating != null) {
		isHydrating = oldVNode._hydrating;
		oldDom = newVNode._dom = oldVNode._dom;
		// if we resume, we want the tree to be "unlocked"
		newVNode._hydrating = null;
		excessDomChildren = [oldDom];
	}

	if ((tmp = options._diff)) tmp(newVNode);

	try {
		outer: if (typeof newType == 'function') {
			let c, isNew, oldProps, oldState, snapshot, clearProcessingException;
			let newProps = newVNode.props;

			// Necessary for createContext api. Setting this property will pass
			// the context value as `this.context` just for this component.
			tmp = newType.contextType;
			let provider;
			let componentContext = tmp
				? (provider = globalContext[tmp._id])
					? provider.props.value
					: tmp._defaultValue
				: globalContext;

			// Get component and set it to `c`
			if (oldVNode._component) {
				c = newVNode._component = oldVNode._component;
				clearProcessingException = c._processingException = c._pendingError;
			} else {
				// Instantiate the new component
				if (newType.prototype && newType.prototype.render) {
					// @ts-ignore The check above verifies that newType is suppose to be constructed
					newVNode._component = c = new newType(newProps, componentContext); // eslint-disable-line new-cap
				} else {
					// @ts-ignore Trust me, Component implements the interface we want
					newVNode._component = c = new Component(newProps, componentContext);
					c.constructor = newType;
					c.render = doRender;
				}
				if (provider) provider.sub(c);

				c.props = newProps;
				if (!c.state) c.state = {};
				c.context = componentContext;
				c._globalContext = globalContext;
				c._dirty = isNew = true;
				c._renderCallbacks = [];
			}

			// Invoke getDerivedStateFromProps
			if (c._nextState == null) {
				c._nextState = c.state;
			}
			if (newType.getDerivedStateFromProps) {
				if (c._nextState == c.state) {
					c._nextState = assign({}, c._nextState);
				}

				assign(
					c._nextState,
					newType.getDerivedStateFromProps(newProps, c._nextState)
				);
			}

			oldProps = c.props;
			oldState = c.state;

			// Invoke pre-render lifecycle methods
			if (isNew) {
				if (!newType.getDerivedStateFromProps && c.componentWillMount) {
					c.componentWillMount();
				}

				if (c.componentDidMount) {
					c._renderCallbacks.push(c.componentDidMount);
				}
			} else {
				if (
					!newType.getDerivedStateFromProps &&
					c.componentWillReceiveProps &&
					newProps !== oldProps
				) {
					c.componentWillReceiveProps(newProps, componentContext);
				}

				if (
					(!c._force &&
						c.shouldComponentUpdate &&
						c.shouldComponentUpdate(
							newProps,
							c._nextState,
							componentContext
						) === false) ||
					newVNode._original === oldVNode._original
				) {
					c.props = newProps;
					c.state = c._nextState;
					// More info about this here: https://gist.github.com/JoviDeCroock/bec5f2ce93544d2e6070ef8e0036e4e8
					if (newVNode._original !== oldVNode._original) c._dirty = false;
					c._vnode = newVNode;
					newVNode._dom = oldVNode._dom;
					(newVNode._children = oldVNode._children).some(vnode => {
						if (vnode) vnode._parent = newVNode;
					});
					if (c._renderCallbacks.length) {
						commitQueue.push(c);
					}

					break outer;
				}

				if (c.componentWillUpdate) {
					c.componentWillUpdate(newProps, c._nextState, componentContext);
				}

				if (c.componentDidUpdate) {
					c._renderCallbacks.push(() => {
						c.componentDidUpdate(oldProps, oldState, snapshot);
					});
				}
			}

			c.context = componentContext;
			c.props = newProps;
			c.state = c._nextState;

			if ((tmp = options._render)) tmp(newVNode);

			c._dirty = false;
			c._vnode = newVNode;
			c._parentDom = parentDom;

			tmp = c.render(c.props, c.state, c.context);

			// Handle setState called in render, see #2553
			c.state = c._nextState;

			if (c.getChildContext) {
				globalContext = assign({}, globalContext, c.getChildContext());
			}

			if (!isNew && c.getSnapshotBeforeUpdate) {
				snapshot = c.getSnapshotBeforeUpdate(oldProps, oldState);
			}

			let isTopLevelFragment = tmp && tmp.type === Fragment && tmp.key == null;
			let renderResult = isTopLevelFragment ? tmp.props.children : tmp;

			diffChildren(
				parentDom,
				Array.isArray(renderResult) ? renderResult : [renderResult],
				newVNode,
				oldVNode,
				globalContext,
				isSvg,
				excessDomChildren,
				commitQueue,
				oldDom,
				isHydrating
			);

			c.base = newVNode._dom;

			// We successfully rendered this VNode, unset any stored hydration/bailout state:
			newVNode._hydrating = null;

			if (c._renderCallbacks.length) {
				commitQueue.push(c);
			}

			if (clearProcessingException) {
				c._pendingError = c._processingException = null;
			}

			c._force = false;
		} else if (
			excessDomChildren == null &&
			newVNode._original === oldVNode._original
		) {
			newVNode._children = oldVNode._children;
			newVNode._dom = oldVNode._dom;
		} else {
			newVNode._dom = diffElementNodes(
				oldVNode._dom,
				newVNode,
				oldVNode,
				globalContext,
				isSvg,
				excessDomChildren,
				commitQueue,
				isHydrating
			);
		}

		if ((tmp = options.diffed)) tmp(newVNode);
	} catch (e) {
		newVNode._original = null;
		// if hydrating or creating initial tree, bailout preserves DOM:
		if (isHydrating || excessDomChildren != null) {
			newVNode._dom = oldDom;
			newVNode._hydrating = !!isHydrating;
			excessDomChildren[excessDomChildren.indexOf(oldDom)] = null;
			// ^ could possibly be simplified to:
			// excessDomChildren.length = 0;
		}
		options._catchError(e, newVNode, oldVNode);
	}
}

/**
 * @param {Array<import('../internal').Component>} commitQueue List of components
 * which have callbacks to invoke in commitRoot
 * @param {import('../internal').VNode} root
 */
export function commitRoot(commitQueue, root) {
	if (options._commit) options._commit(root, commitQueue);

	commitQueue.some(c => {
		try {
			// @ts-ignore Reuse the commitQueue variable here so the type changes
			commitQueue = c._renderCallbacks;
			c._renderCallbacks = [];
			commitQueue.some(cb => {
				// @ts-ignore See above ts-ignore on commitQueue
				cb.call(c);
			});
		} catch (e) {
			options._catchError(e, c._vnode);
		}
	});
}

/**
 * Diff two virtual nodes representing DOM element
 * @param {import('../internal').PreactElement} dom The DOM element representing
 * the virtual nodes being diffed
 * @param {import('../internal').VNode} newVNode The new virtual node
 * @param {import('../internal').VNode} oldVNode The old virtual node
 * @param {object} globalContext The current context object
 * @param {boolean} isSvg Whether or not this DOM node is an SVG node
 * @param {*} excessDomChildren
 * @param {Array<import('../internal').Component>} commitQueue List of components
 * which have callbacks to invoke in commitRoot
 * @param {boolean} isHydrating Whether or not we are in hydration
 * @returns {import('../internal').PreactElement}
 */
function diffElementNodes(
	dom,
	newVNode,
	oldVNode,
	globalContext,
	isSvg,
	excessDomChildren,
	commitQueue,
	isHydrating
) {
	let oldProps = oldVNode.props,
		newProps = newVNode.props,
		nodeType = newVNode.type,
		i;

	if (excessDomChildren != null) {
		for (i = 0; i < excessDomChildren.length; i++) {
			const child = excessDomChildren[i];

			// if newVNode matches an element in excessDomChildren or the `dom`
			// argument matches an element in excessDomChildren, remove it from
			// excessDomChildren so it isn't later removed in diffChildren
			if (
				child &&
				(child === dom ||
					(nodeType ? child.localName == nodeType : child.nodeType == 3))
			) {
				dom = child;
				excessDomChildren[i] = null;
				break;
			}
		}
	}

	if (nodeType === null) {
		if (dom == null) {
			// @ts-ignore createTextNode returns Text, we expect PreactElement
			return document.createTextNode(newProps);
		}

		// During hydration, we still have to split merged text from SSR'd HTML.
		if (oldProps !== newProps && (!isHydrating || dom.data !== newProps)) {
			dom.data = newProps;
		}
	} else {
		// Tracks entering and exiting SVG namespace when descending through the tree.
		if (nodeType === 'svg') isSvg = true;

		if (dom == null) {
			if (isSvg) {
				dom = document.createElementNS(
					'http://www.w3.org/2000/svg',
					// @ts-ignore We know `newVNode.type` is a string
					nodeType
				);
			} else {
				dom = document.createElement(
					// @ts-ignore We know `newVNode.type` is a string
					nodeType,
					newProps.is && newProps
				);
			}

			// we created a new parent, so none of the previously attached children can be reused:
			excessDomChildren = null;
			// we are creating a new node, so we can assume this is a new subtree (in case we are hydrating), this deopts the hydrate
			isHydrating = false;
		}

		// If excessDomChildren was not null, repopulate it with the current element's children:
		if (excessDomChildren) excessDomChildren = slice.call(dom.childNodes);

		if (!oldProps) oldProps = EMPTY_OBJ;

		let oldHtml = oldProps.dangerouslySetInnerHTML;
		let newHtml = newProps.dangerouslySetInnerHTML;

		// During hydration, props are not diffed at all (including dangerouslySetInnerHTML)
		// @TODO we should warn in debug mode when props don't match here.
		if (!isHydrating) {
			// But, if we are in a situation where we are using existing DOM (e.g. replaceNode)
			// we should read the existing DOM attributes to diff them
			if (excessDomChildren != null) {
				oldProps = {};
				for (i = 0; i < dom.attributes.length; i++) {
					let attr = dom.attributes[i];
					oldProps[attr.name] = attr.value;
				}
			}

			if (newHtml || oldHtml) {
				// Avoid re-applying the same '__html' if it did not changed between re-render
				if (
					!newHtml ||
					((!oldHtml || newHtml.__html != oldHtml.__html) &&
						newHtml.__html !== dom.innerHTML)
				) {
					dom.innerHTML = (newHtml && newHtml.__html) || '';
				}
			}
		}

		for (i in oldProps) {
			if (i !== 'children' && i !== 'key' && !(i in newProps)) {
				setProperty(dom, i, null, oldProps[i], isSvg);
			}
		}

		for (i in newProps) {
			if (
				(!isHydrating || typeof newProps[i] == 'function') &&
				i !== 'children' &&
				i !== 'key' &&
				i !== 'value' &&
				i !== 'checked' &&
				newProps[i] !== oldProps[i]
			) {
				setProperty(dom, i, newProps[i], oldProps[i], isSvg);
			}
		}

		// If the new vnode didn't have dangerouslySetInnerHTML, diff its children
		if (newHtml) {
			newVNode._children = [];
		} else {
			i = newVNode.props.children;
			diffChildren(
				dom,
				Array.isArray(i) ? i : [i],
				newVNode,
				oldVNode,
				globalContext,
				isSvg && nodeType !== 'foreignObject',
				excessDomChildren,
				commitQueue,
				dom.firstChild,
				isHydrating
			);

			// Remove children that are not part of any vnode.
			if (excessDomChildren != null) {
				for (i = excessDomChildren.length; i--; ) {
					if (excessDomChildren[i] != null) removeNode(excessDomChildren[i]);
				}
			}
		}

		// (as above, don't diff props during hydration)
		if (!isHydrating) {
			if (
				(i = newProps.value) !== undefined &&
				// #2756 For the <progress>-element the initial value is 0,
				// despite the attribute not being present. When the attribute
				// is missing the progress bar is treated as indeterminate.
				// To fix that we'll always update it when it is 0 for progress elements
				(i !== dom.value || (nodeType === 'progress' && !i))
			) {
				setProperty(dom, 'value', i, oldProps.value);
			}
			if ((i = newProps.checked) !== undefined && i !== dom.checked) {
				setProperty(dom, 'checked', i, oldProps.checked);
			}
		}
	}

	return dom;
}

/**
 * Invoke or update a ref, depending on whether it is a function or object ref.
 * @param {object|function} ref
 * @param {any} value
 * @param {import('../internal').VNode} vnode
 */
export function applyRef(ref, value, vnode) {
	if (typeof ref == 'function') {
		try {
			ref(value);
		} catch (e) {
			options._catchError(e, vnode);
		}
	} else {
		ref.current = value;
	}
}

/**
 * Unmount a virtual node from the tree and apply DOM changes
 * @param {import('../internal').VNode} vnode The virtual node to unmount
 * @param {import('../internal').VNode} parentVNode The parent of the VNode that
 * initiated the unmount
 * @param {boolean} [skipRemove] Flag that indicates that a parent node of the
 * current element is already detached from the DOM.
 */
export function unmount(vnode, parentVNode, skipRemove) {
	let r;

	if ((r = options.unmount)) r(vnode);

	if ((r = vnode.ref) && (!r.current || r.current === vnode._dom)) {
		applyRef(r, null, parentVNode);
	}

	if ((r = vnode._component)) {
		if (r.componentWillUnmount) {
			try {
				r.componentWillUnmount();
			} catch (e) {
				options._catchError(e, parentVNode);
			}
		}

		r.base = r._parentDom = null;
	}

	if ((r = vnode._children)) {
		for (
			let v, skip = typeof vnode.type != 'function', i = 0;
			i < r.length;
			i++
		) {
			if ((v = r[i])) unmount(v, parentVNode, skip);
		}
	}

	if (!skipRemove && (r = vnode._dom)) removeNode(r);

	// Must be set to `undefined` to properly clean up `_nextDom`
	// for which `null` is a valid value. See comment in `create-element.js`
	vnode._dom = vnode._nextDom = undefined;
}

/** The `.render()` method for a PFC backing instance. */
function doRender(props, _state, context) {
	return this.constructor(props, context);
}
