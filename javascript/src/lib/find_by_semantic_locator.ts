/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {getNameFor, nameMatches} from './accessible_name';
import {computeARIAAttributeValue} from './attribute';
import {NoSuchElementError} from './error';
import {buildFailureMessage, combineMostSpecific, EmptyResultsMetadata, isEmptyResultsMetadata, isNonEmptyResult, Result} from './lookup_result';
import {outerNodesOnly} from './outer';
import {parse} from './parse_locator';
import {findByRole} from './role';
import {SemanticLocator, SemanticNode} from './semantic_locator';
import {assertInDocumentOrder, compareNodeOrder, removeDuplicates} from './util';


/**
 * Find all elements in the DOM by the given semantic locator and returns them
 * in the correct order.
 */
export function findElementsBySemanticLocator(
    locator: string,
    root: HTMLElement = document.body,
    includeHidden: boolean = false,
    ): HTMLElement[] {
  const result = findBySemanticLocator(parse(locator), root, includeHidden);
  if (isEmptyResultsMetadata(result)) {
    return [];
  }
  return result.found as HTMLElement[];
}

/**
 * Find the first element in the DOM by the given semantic locator. Throws
 * NoSuchElementError if no matching elements are found.
 */
export function findElementBySemanticLocator(
    locator: string,
    root: HTMLElement = document.body,
    includeHidden: boolean = false,
    ): HTMLElement {
  const parsed = parse(locator);
  const result = findBySemanticLocator(parsed, root, includeHidden);
  if (isEmptyResultsMetadata(result)) {
    let hiddenMatches: readonly HTMLElement[] = [];
    if (!includeHidden) {
      const hiddenResult = findBySemanticLocator(parsed, root, true);
      hiddenMatches =
          isEmptyResultsMetadata(hiddenResult) ? [] : hiddenResult.found;
    }
    throw new NoSuchElementError(
        buildFailureMessage(parsed, result, hiddenMatches));
  }
  return result.found[0];
}

/**
 * @return a list of elements in the document which are matched by the locator.
 *     Returns elements in document order.
 */
export function findBySemanticLocator(
    locator: SemanticLocator,
    root: HTMLElement = document.body,
    includeHidden: boolean = false,
    ): Result {
  const searchBase =
      findBySemanticNodes(locator.preOuter, [root], includeHidden);
  if (isEmptyResultsMetadata(searchBase)) {
    return searchBase;
  }
  if (locator.postOuter.length === 0) {
    return searchBase;
  }
  const results =
      searchBase
          .found
          // 'outer' semantics are relative to the search base so we must do a
          // separate call to findBySemanticNodes for each base, then filter the
          // results for each base individually
          // TODO(alexlloyd) this could be optimised with a k-way merge removing
          // duplicates rather than concat + sort in separate steps.
          .map(
              base => findBySemanticNodes(
                  locator.postOuter, [base], includeHidden));
  const elementsFound = results.filter(isNonEmptyResult)
                            .flatMap(result => outerNodesOnly(result.found));

  if (elementsFound.length === 0) {
    const noneFound = combineMostSpecific(results as EmptyResultsMetadata[]);
    return {
      closestFind: locator.preOuter.concat(noneFound.closestFind),
      elementsFound: noneFound.elementsFound,
      notFound: noneFound.notFound,
      partialFind: noneFound.partialFind,
    };
  }

  // If node.outer then there's no guarantee that elements are
  // unique or in document order.
  //
  // e.g. locator "{list} outer {listitem}" and DOM:
  //
  // <ul id="a">
  //   <ul id="b">
  //     <li id="c"></li>
  //   </ul>
  //   <li id="d"></li>
  // </ul>
  //
  // searchBase = [a, b] so found = [c, d, c]
  // So sort by document order to maintain the invariant
  return {found: removeDuplicates(elementsFound.sort(compareNodeOrder))};
}

function findBySemanticNodes(
    nodes: readonly SemanticNode[],
    searchBase: readonly HTMLElement[],
    includeHidden: boolean,
    ): Result {
  for (let i = 0; i < nodes.length; i++) {
    const result = findBySemanticNode(nodes[i], searchBase, includeHidden);
    if (isEmptyResultsMetadata(result)) {
      return {
        closestFind: nodes.slice(0, i),
        elementsFound: result.elementsFound,
        notFound: result.notFound,
        partialFind: result.partialFind
      };
    }
    searchBase = result.found;
  }
  return {found: searchBase};
}

/**
 * @param `searchBase` elements to search below. These elements must be in
 *     document order.
 * @return a list of elements under `searchBase` in document order.
 */
function findBySemanticNode(
    node: SemanticNode,
    searchBase: readonly HTMLElement[],
    includeHidden: boolean,
    ): Result {
  // Filter out non-outer elements as an optimisation. Suppose A and B are in
  // searchBase, and A contains B. Then all nodes below B are also below A so
  // there's no point searching below B.
  //
  // Filtering here has the added benefit of making it easy to return elements
  // in document order.
  searchBase = outerNodesOnly(searchBase);

  let elements =
      searchBase.flatMap(base => findByRole(node.role, base, includeHidden));
  if (elements.length === 0) {
    return {
      closestFind: [],
      elementsFound: searchBase,
      notFound: {role: node.role},
    };
  }

  const attributes = node.attributes;
  for (let i = 0; i < attributes.length; i++) {
    const nextElements = elements.filter(
        element => computeARIAAttributeValue(element, attributes[i].name) ===
            attributes[i].value);

    if (nextElements.length === 0) {
      return {
        closestFind: [],
        elementsFound: elements,
        notFound: {attribute: attributes[i]},
        partialFind: {role: node.role, attributes: attributes.slice(0, i)},
      };
    }
    elements = nextElements;
  }

  if (node.name) {
    const nextElements = elements.filter(
        element => nameMatches(node.name!, getNameFor(element)));
    if (nextElements.length === 0) {
      return {
        closestFind: [],
        elementsFound: elements,
        notFound: {name: node.name},
        partialFind: {role: node.role, attributes: node.attributes},
      };
    }
    elements = nextElements;
  }
  assertInDocumentOrder(elements);
  return {found: elements};
}
