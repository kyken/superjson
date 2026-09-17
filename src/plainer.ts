import {
  isArray,
  isEmptyObject,
  isError,
  isMap,
  isPlainObject,
  isPrimitive,
  isSet,
} from './is.js';
import { escapeKey, stringifyPath } from './pathstringifier.js';
import {
  isInstanceOfRegisteredClass,
  transformValue,
  TypeAnnotation,
  untransformValue,
} from './transformer.js';
import { includes, forEach } from './util.js';
import { parsePath } from './pathstringifier.js';
import { getDeep, setDeep } from './accessDeep.js';
import { getDeepAsync, setDeepAsync } from './accessDeep.js';
import { AsyncYieldController } from './async.js';
import SuperJSON from './index.js';

type Tree<T> = InnerNode<T> | Leaf<T>;
type Leaf<T> = [T];
type InnerNode<T> = [T, Record<string, Tree<T>>];

export type MinimisedTree<T> = Tree<T> | Record<string, Tree<T>> | undefined;

const enableLegacyPaths = (version: number) => version < 1;

function traverse<T>(
  tree: MinimisedTree<T>,
  walker: (v: T, path: string[]) => void,
  version: number,
  origin: string[] = []
): void {
  if (!tree) {
    return;
  }

  const legacyPaths = enableLegacyPaths(version);
  if (!isArray(tree)) {
    forEach(tree, (subtree, key) =>
      traverse(subtree, walker, version, [
        ...origin,
        ...parsePath(key, legacyPaths),
      ])
    );
    return;
  }

  const [nodeValue, children] = tree;
  if (children) {
    forEach(children, (child, key) => {
      traverse(child, walker, version, [
        ...origin,
        ...parsePath(key, legacyPaths),
      ]);
    });
  }

  walker(nodeValue, origin);
}

async function traverseAsync<T>(
  tree: MinimisedTree<T>,
  walker: (v: T, path: string[]) => Promise<void>,
  version: number,
  scheduler: AsyncYieldController,
  origin: string[] = []
): Promise<void> {
  if (!tree) {
    return;
  }

  await scheduler.tick();
  const legacyPaths = enableLegacyPaths(version);
  if (!isArray(tree)) {
    for (const [key, subtree] of Object.entries(tree)) {
      await traverseAsync(
        subtree,
        walker,
        version,
        scheduler,
        [...origin, ...parsePath(key, legacyPaths)]
      );
    }
    return;
  }

  const [nodeValue, children] = tree;
  if (children) {
    for (const [key, child] of Object.entries(children)) {
      await traverseAsync(
        child,
        walker,
        version,
        scheduler,
        [...origin, ...parsePath(key, legacyPaths)]
      );
    }
  }

  await walker(nodeValue, origin);
}

export function applyValueAnnotations(
  plain: any,
  annotations: MinimisedTree<TypeAnnotation>,
  version: number,
  superJson: SuperJSON
) {
  traverse(
    annotations,
    (type, path) => {
      plain = setDeep(plain, path, v => untransformValue(v, type, superJson));
    },
    version
  );

  return plain;
}

export async function applyValueAnnotationsAsync(
  plain: any,
  annotations: MinimisedTree<TypeAnnotation>,
  version: number,
  superJson: SuperJSON,
  scheduler: AsyncYieldController
) {
  await traverseAsync(
    annotations,
    async (type, path) => {
      plain = await setDeepAsync(
        plain,
        path,
        v => untransformValue(v, type, superJson),
        scheduler
      );
    },
    version,
    scheduler
  );

  return plain;
}

export function applyReferentialEqualityAnnotations(
  plain: any,
  annotations: ReferentialEqualityAnnotations,
  version: number
) {
  const legacyPaths = enableLegacyPaths(version);
  function apply(identicalPaths: string[], path: string) {
    const object = getDeep(plain, parsePath(path, legacyPaths));

    identicalPaths
      .map(path => parsePath(path, legacyPaths))
      .forEach(identicalObjectPath => {
        plain = setDeep(plain, identicalObjectPath, () => object);
      });
  }

  if (isArray(annotations)) {
    const [root, other] = annotations;
    root.forEach(identicalPath => {
      plain = setDeep(
        plain,
        parsePath(identicalPath, legacyPaths),
        () => plain
      );
    });

    if (other) {
      forEach(other, apply);
    }
  } else {
    forEach(annotations, apply);
  }

  return plain;
}

export async function applyReferentialEqualityAnnotationsAsync(
  plain: any,
  annotations: ReferentialEqualityAnnotations,
  version: number,
  scheduler: AsyncYieldController
) {
  const legacyPaths = enableLegacyPaths(version);
  async function apply(identicalPaths: string[], path: string) {
    const object = await getDeepAsync(
      plain,
      parsePath(path, legacyPaths),
      scheduler
    );

    for (const identicalPath of identicalPaths) {
      await scheduler.tick();
      plain = await setDeepAsync(
        plain,
        parsePath(identicalPath, legacyPaths),
        () => object,
        scheduler
      );
    }
  }

  if (isArray(annotations)) {
    const [root, other] = annotations;
    for (const identicalPath of root) {
      await scheduler.tick();
      plain = await setDeepAsync(
        plain,
        parsePath(identicalPath, legacyPaths),
        () => plain,
        scheduler
      );
    }

    if (other) {
      for (const [path, identicalPaths] of Object.entries(other)) {
        await apply(identicalPaths, path);
      }
    }
  } else {
    for (const [path, identicalPaths] of Object.entries(annotations)) {
      await apply(identicalPaths, path);
    }
  }

  return plain;
}

const isDeep = (object: any, superJson: SuperJSON): boolean =>
  isPlainObject(object) ||
  isArray(object) ||
  isMap(object) ||
  isSet(object) ||
  isError(object) ||
  isInstanceOfRegisteredClass(object, superJson);

function addIdentity(object: any, path: any[], identities: Map<any, any[][]>) {
  const existingSet = identities.get(object);

  if (existingSet) {
    existingSet.push(path);
  } else {
    identities.set(object, [path]);
  }
}

interface Result {
  transformedValue: any;
  annotations?: MinimisedTree<TypeAnnotation>;
}

export type ReferentialEqualityAnnotations =
  | Record<string, string[]>
  | [string[]]
  | [string[], Record<string, string[]>];

export function generateReferentialEqualityAnnotations(
  identitites: Map<any, any[][]>,
  dedupe: boolean
): ReferentialEqualityAnnotations | undefined {
  const result: Record<string, string[]> = {};
  let rootEqualityPaths: string[] | undefined = undefined;

  identitites.forEach(paths => {
    if (paths.length <= 1) {
      return;
    }

    // if we're not deduping, all of these objects continue existing.
    // putting the shortest path first makes it easier to parse for humans
    // if we're deduping though, only the first entry will still exist, so we can't do this optimisation.
    if (!dedupe) {
      paths = paths
        .map(path => path.map(String))
        .sort((a, b) => a.length - b.length);
    }

    const [representativePath, ...identicalPaths] = paths;

    if (representativePath.length === 0) {
      rootEqualityPaths = identicalPaths.map(stringifyPath);
    } else {
      result[stringifyPath(representativePath)] = identicalPaths.map(
        stringifyPath
      );
    }
  });

  if (rootEqualityPaths) {
    if (isEmptyObject(result)) {
      return [rootEqualityPaths];
    } else {
      return [rootEqualityPaths, result];
    }
  } else {
    return isEmptyObject(result) ? undefined : result;
  }
}

export async function generateReferentialEqualityAnnotationsAsync(
  identitites: Map<any, any[][]>,
  dedupe: boolean,
  scheduler: AsyncYieldController
): Promise<ReferentialEqualityAnnotations | undefined> {
  const result: Record<string, string[]> = {};
  let rootEqualityPaths: string[] | undefined = undefined;

  for (const pathsInMap of identitites.values()) {
    await scheduler.tick();
    let paths = pathsInMap;
    if (paths.length <= 1) {
      continue;
    }

    if (!dedupe) {
      const stringifiedPaths: string[][] = [];
      for (const path of paths) {
        await scheduler.tick();
        stringifiedPaths.push(path.map(String));
      }
      paths = stringifiedPaths.sort((a, b) => a.length - b.length);
    }

    const [representativePath, ...identicalPaths] = paths;
    if (representativePath.length === 0) {
      rootEqualityPaths = [];
      for (const path of identicalPaths) {
        await scheduler.tick();
        rootEqualityPaths.push(stringifyPath(path.map(String)));
      }
    } else {
      const stringifiedIdenticalPaths: string[] = [];
      for (const path of identicalPaths) {
        await scheduler.tick();
        stringifiedIdenticalPaths.push(stringifyPath(path.map(String)));
      }
      result[stringifyPath(representativePath.map(String))] =
        stringifiedIdenticalPaths;
    }
  }

  if (rootEqualityPaths) {
    if (isEmptyObject(result)) {
      return [rootEqualityPaths];
    } else {
      return [rootEqualityPaths, result];
    }
  } else {
    return isEmptyObject(result) ? undefined : result;
  }
}

export const walker = (
  object: any,
  identities: Map<any, any[][]>,
  superJson: SuperJSON,
  dedupe: boolean,
  path: any[] = [],
  objectsInThisPath: any[] = [],
  seenObjects = new Map<unknown, Result>()
): Result => {
  const primitive = isPrimitive(object);

  if (!primitive) {
    addIdentity(object, path, identities);

    const seen = seenObjects.get(object);
    if (seen) {
      // short-circuit result if we've seen this object before
      return dedupe
        ? {
            transformedValue: null,
          }
        : seen;
    }
  }

  if (!isDeep(object, superJson)) {
    const transformed = transformValue(object, superJson);

    const result: Result = transformed
      ? {
          transformedValue: transformed.value,
          annotations: [transformed.type],
        }
      : {
          transformedValue: object,
        };
    if (!primitive) {
      seenObjects.set(object, result);
    }
    return result;
  }

  if (includes(objectsInThisPath, object)) {
    // prevent circular references
    return {
      transformedValue: null,
    };
  }

  const transformationResult = transformValue(object, superJson);
  const transformed = transformationResult?.value ?? object;

  const transformedValue: any = isArray(transformed) ? [] : {};
  const innerAnnotations: Record<string, Tree<TypeAnnotation>> = {};

  forEach(transformed, (value, index) => {
    if (
      index === '__proto__' ||
      index === 'constructor' ||
      index === 'prototype'
    ) {
      throw new Error(
        `Detected property ${index}. This is a prototype pollution risk, please remove it from your object.`
      );
    }

    const recursiveResult = walker(
      value,
      identities,
      superJson,
      dedupe,
      [...path, index],
      [...objectsInThisPath, object],
      seenObjects
    );

    transformedValue[index] = recursiveResult.transformedValue;

    if (isArray(recursiveResult.annotations)) {
      innerAnnotations[escapeKey(index)] = recursiveResult.annotations;
    } else if (isPlainObject(recursiveResult.annotations)) {
      forEach(recursiveResult.annotations, (tree, key) => {
        innerAnnotations[escapeKey(index) + '.' + key] = tree;
      });
    }
  });

  const result: Result = isEmptyObject(innerAnnotations)
    ? {
        transformedValue,
        annotations: !!transformationResult
          ? [transformationResult.type]
          : undefined,
      }
    : {
        transformedValue,
        annotations: !!transformationResult
          ? [transformationResult.type, innerAnnotations]
          : innerAnnotations,
      };
  if (!primitive) {
    seenObjects.set(object, result);
  }

  return result;
};

export const asyncWalker = async (
  object: any,
  identities: Map<any, any[][]>,
  superJson: SuperJSON,
  dedupe: boolean,
  scheduler: AsyncYieldController,
  path: any[] = [],
  objectsInThisPath: any[] = [],
  seenObjects = new Map<unknown, Result>()
): Promise<Result> => {
  await scheduler.tick();
  const primitive = isPrimitive(object);

  if (!primitive) {
    addIdentity(object, path, identities);

    const seen = seenObjects.get(object);
    if (seen) {
      return dedupe
        ? {
            transformedValue: null,
          }
        : seen;
    }
  }

  if (!isDeep(object, superJson)) {
    const transformed = transformValue(object, superJson);

    const result: Result = transformed
      ? {
          transformedValue: transformed.value,
          annotations: [transformed.type],
        }
      : {
          transformedValue: object,
        };
    if (!primitive) {
      seenObjects.set(object, result);
    }
    return result;
  }

  if (includes(objectsInThisPath, object)) {
    return {
      transformedValue: null,
    };
  }

  const transformationResult = transformValue(object, superJson);
  const transformed = transformationResult?.value ?? object;

  const transformedValue: any = isArray(transformed) ? [] : {};
  const innerAnnotations: Record<string, Tree<TypeAnnotation>> = {};

  for (const [index, value] of Object.entries(transformed)) {
    await scheduler.tick();
    if (
      index === '__proto__' ||
      index === 'constructor' ||
      index === 'prototype'
    ) {
      throw new Error(
        `Detected property ${index}. This is a prototype pollution risk, please remove it from your object.`
      );
    }

    const recursiveResult = await asyncWalker(
      value,
      identities,
      superJson,
      dedupe,
      scheduler,
      [...path, index],
      [...objectsInThisPath, object],
      seenObjects
    );

    transformedValue[index] = recursiveResult.transformedValue;

    if (isArray(recursiveResult.annotations)) {
      innerAnnotations[escapeKey(index)] = recursiveResult.annotations;
    } else if (isPlainObject(recursiveResult.annotations)) {
      for (const [key, tree] of Object.entries(recursiveResult.annotations)) {
        innerAnnotations[escapeKey(index) + '.' + key] = tree;
      }
    }
  }

  const result: Result = isEmptyObject(innerAnnotations)
    ? {
        transformedValue,
        annotations: !!transformationResult
          ? [transformationResult.type]
          : undefined,
      }
    : {
        transformedValue,
        annotations: !!transformationResult
          ? [transformationResult.type, innerAnnotations]
          : innerAnnotations,
      };
  if (!primitive) {
    seenObjects.set(object, result);
  }

  return result;
};
