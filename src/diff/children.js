import { diff, unmount, applyRef } from './index';
import { createVNode, Fragment } from '../create-element';
import { EMPTY_OBJ, EMPTY_ARR } from '../constants';
import { getDomSibling } from '../component';

/**
 * Diff the children of a virtual node
 * @param {import('../internal').PreactElement} parentDom The DOM element whose
 * children are being diffed
 * @param {import('../internal').ComponentChildren[]} renderResult
 * @param {import('../internal').VNode} newParentVNode The new virtual
 * node whose children should be diff'ed against oldParentVNode
 * @param {import('../internal').VNode} oldParentVNode The old virtual
 * node whose children should be diff'ed against newParentVNode
 * @param {object} globalContext The current context object - modified by getChildContext
 * @param {boolean} isSvg Whether or not this DOM node is an SVG node
 * @param {Array<import('../internal').PreactElement>} excessDomChildren
 * @param {Array<import('../internal').Component>} commitQueue List of components
 * which have callbacks to invoke in commitRoot
 * @param {import('../internal').PreactElement} oldDom The current attached DOM
 * element any new dom elements should be placed around. Likely `null` on first
 * render (except when hydrating). Can be a sibling DOM element when diffing
 * Fragments that have siblings. In most cases, it starts out as `oldChildren[0]._dom`.
 * @param {boolean} isHydrating Whether or not we are in hydration
 */
export function diffChildren(
	parentDom,
	renderResult,
	newParentVNode,
	oldParentVNode,
	globalContext,
	isSvg,
	excessDomChildren,
	commitQueue,
	oldDom,
	isHydrating
) {
	let i, j, oldVNode, childVNode, newDom, firstChildDom, refs;

	// This is a compression of oldParentVNode!=null && oldParentVNode != EMPTY_OBJ && oldParentVNode._children || EMPTY_ARR
	// as EMPTY_OBJ._children should be `undefined`.
	let oldChildren = (oldParentVNode && oldParentVNode._children) || EMPTY_ARR;
	let k = oldChildren.length;

	newParentVNode._children = [];
	for (i = 0; i < renderResult.length; i++) {
		childVNode = renderResult[i];

		if (childVNode == null || typeof childVNode == 'boolean') {
			childVNode = newParentVNode._children[i] = null;
		}
		// If this newVNode is being reused (e.g. <div>{reuse}{reuse}</div>) in the same diff,
		// or we are rendering a component (e.g. setState) copy the oldVNodes so it can have
		// it's own DOM & etc. pointers
		else if (
			typeof childVNode == 'string' ||
			typeof childVNode == 'number' ||
			// eslint-disable-next-line valid-typeof
			typeof childVNode == 'bigint'
		) {
			childVNode = newParentVNode._children[i] = createVNode(
				null,
				childVNode,
				null,
				null,
				childVNode
			);
		} else if (Array.isArray(childVNode)) {
			childVNode = newParentVNode._children[i] = createVNode(
				Fragment,
				{ children: childVNode },
				null,
				null
			);
		} else if (childVNode._depth > 0) {
			// VNode is already in use, clone it. This can happen in the following
			// scenario:
			//   const reuse = <div />
			//   <div>{reuse}<span />{reuse}</div>
			childVNode = newParentVNode._children[i] = createVNode(
				childVNode.type,
				childVNode.props,
				childVNode.key,
				null,
				childVNode._original
			);
		} else {
			childVNode = newParentVNode._children[i] = childVNode;
		}

		// Terser removes the `continue` here and wraps the loop body
		// in a `if (childVNode) { ... } condition
		if (childVNode == null) {
			continue;
		}

		childVNode._parent = newParentVNode;
		childVNode._depth = newParentVNode._depth + 1;

		// Check if we find a corresponding element in oldChildren.
		// If found, delete the array item by setting to `undefined`.
		// We use `undefined`, as `null` is reserved for empty placeholders
		// (holes).
		oldVNode = oldChildren[i];

		if (
			oldVNode === null ||
			(oldVNode &&
				childVNode.key == oldVNode.key &&
				childVNode.type === oldVNode.type)
		) {
			oldChildren[i] = undefined;
		} else {
			// Either oldVNode === undefined or oldChildrenLength > 0,
			// so after this loop oldVNode == null or oldVNode is a valid value.
			for (j = 0; j < k; j++) {
				oldVNode = oldChildren[j];
				// If childVNode is unkeyed, we only match similarly unkeyed nodes, otherwise we match by key.
				// We always match by type (in either case).
				if (
					oldVNode &&
					childVNode.key == oldVNode.key &&
					childVNode.type === oldVNode.type
				) {
					oldChildren[j] = undefined;
					break;
				}
				oldVNode = null;
			}
		}

		oldVNode = oldVNode || EMPTY_OBJ;

		// Morph the old element into the new one, but don't append it to the dom yet
		diff(
			parentDom,
			childVNode,
			oldVNode,
			globalContext,
			isSvg,
			excessDomChildren,
			commitQueue,
			oldDom,
			isHydrating
		);

		newDom = childVNode._dom;

		if ((j = childVNode.ref) && oldVNode.ref != j) {
			if (!refs) refs = [];
			if (oldVNode.ref) refs.push(oldVNode.ref, null, childVNode);
			refs.push(j, childVNode._component || newDom, childVNode);
		}

		if (newDom != null) {
			if (firstChildDom == null) {
				firstChildDom = newDom;
			}

			if (
				typeof childVNode.type == 'function' &&
				childVNode._children != null && // Can be null if childVNode suspended
				childVNode._children === oldVNode._children
			) {
				childVNode._nextDom = oldDom = reorderChildren(
					childVNode,
					oldDom,
					parentDom
				);
			} else {
				oldDom = placeChild(
					parentDom,
					childVNode,
					oldVNode,
					oldChildren,
					newDom,
					oldDom
				);
			}

			// Browsers will infer an option's `value` from `textContent` when
			// no value is present. This essentially bypasses our code to set it
			// later in `diff()`. It works fine in all browsers except for IE11
			// where it breaks setting `select.value`. There it will be always set
			// to an empty string. Re-applying an options value will fix that, so
			// there are probably some internal data structures that aren't
			// updated properly.
			//
			// To fix it we make sure to reset the inferred value, so that our own
			// value check in `diff()` won't be skipped.
			if (!isHydrating && newParentVNode.type === 'option') {
				// @ts-ignore We have validated that the type of parentDOM is 'option'
				// in the above check
				parentDom.value = '';
			} else if (typeof newParentVNode.type == 'function') {
				// Because the newParentVNode is Fragment-like, we need to set it's
				// _nextDom property to the nextSibling of its last child DOM node.
				//
				// `oldDom` contains the correct value here because if the last child
				// is a Fragment-like, then oldDom has already been set to that child's _nextDom.
				// If the last child is a DOM VNode, then oldDom will be set to that DOM
				// node's nextSibling.
				newParentVNode._nextDom = oldDom;
			}
		} else if (
			oldDom &&
			oldVNode._dom == oldDom &&
			oldDom.parentNode != parentDom
		) {
			// The above condition is to handle null placeholders. See test in placeholder.test.js:
			// `efficiently replace null placeholders in parent rerenders`
			oldDom = getDomSibling(oldVNode);
		}
	}

	newParentVNode._dom = firstChildDom;

	// Remove remaining oldChildren if there are any.
	while (k--) {
		childVNode = oldChildren[k];
		if (childVNode != null) {
			if (
				typeof newParentVNode.type == 'function' &&
				childVNode._dom != null &&
				childVNode._dom == newParentVNode._nextDom
			) {
				// If the newParentVNode.__nextDom points to a dom node that is about to
				// be unmounted, then get the next sibling of that vnode and set
				// _nextDom to it
				newParentVNode._nextDom = getDomSibling(oldParentVNode, k + 1);
			}

			unmount(childVNode, childVNode);
		}
	}

	// Set refs only after unmount
	if (refs) {
		for (i = 0; i < refs.length; ) {
			applyRef(refs[i++], refs[i++], refs[i++]);
		}
	}
}

function reorderChildren(childVNode, oldDom, parentDom) {
	for (
		let vnode, children = childVNode._children, i = 0;
		i < children.length;
		i++
	) {
		if ((vnode = children[i])) {
			// We typically enter this code path on sCU bailout, where we copy
			// oldVNode._children to newVNode._children. If that is the case, we need
			// to update the old children's _parent pointer to point to the newVNode
			// (childVNode here).
			vnode._parent = childVNode;

			if (typeof vnode.type == 'function') {
				children = (childVNode = vnode)._children;
				i = -1;
			} else {
				oldDom = placeChild(
					parentDom,
					vnode,
					vnode,
					children,
					vnode._dom,
					oldDom
				);
			}
		}
	}

	return oldDom;
}

/**
 * Flatten and loop through the children of a virtual node
 * @param {import('../index').ComponentChildren} children The unflattened
 * children of a virtual node
 * @returns {import('../internal').VNode[]}
 */
export function toChildArray(children, out = []) {
	if (children == null || typeof children == 'boolean') {
	} else if (Array.isArray(children)) {
		children.some(child => {
			toChildArray(child, out);
		});
	} else {
		out.push(children);
	}
	return out;
}

function placeChild(
	parentDom,
	childVNode,
	oldVNode,
	oldChildren,
	newDom,
	oldDom
) {
	let nextDom;
	if (childVNode._nextDom !== undefined) {
		// Only Fragments or components that return Fragment like VNodes will
		// have a non-undefined _nextDom. Continue the diff from the sibling
		// of last DOM child of this child VNode
		nextDom = childVNode._nextDom;

		// Eagerly cleanup _nextDom. We don't need to persist the value because
		// it is only used by `diffChildren` to determine where to resume the diff after
		// diffing Components and Fragments. Once we store it the nextDOM local var, we
		// can clean up the property
		childVNode._nextDom = undefined;
	} else if (
		oldVNode == null ||
		newDom != oldDom ||
		newDom.parentNode == null
	) {
		outer: if (oldDom == null || oldDom.parentNode !== parentDom) {
			parentDom.appendChild(newDom);
			nextDom = null;
		} else {
			// `j<oldChildrenLength; j+=2` is an alternative to `j++<oldChildrenLength/2`
			for (
				let sibDom = oldDom, i = 0;
				(sibDom = sibDom.nextSibling) && i < oldChildren.length;
				i += 2
			) {
				if (sibDom == newDom) {
					break outer;
				}
			}
			parentDom.insertBefore(newDom, oldDom);
			nextDom = oldDom;
		}
	}

	// If we have pre-calculated the nextDOM node, use it. Else calculate it now
	// Strictly check for `undefined` here cuz `null` is a valid value of `nextDom`.
	// See more detail in create-element.js:createVNode
	if (nextDom !== undefined) {
		oldDom = nextDom;
	} else {
		oldDom = newDom.nextSibling;
	}

	return oldDom;
}
