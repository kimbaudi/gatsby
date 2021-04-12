const _ = require(`lodash`)
const stringify = require(`json-stringify-safe`)

const typePrefix = `Contentful`
export const makeTypeName = type =>
  _.upperFirst(_.camelCase(`${typePrefix} ${type}`))

const getLocalizedField = ({ field, locale, localesFallback }) => {
  if (!_.isUndefined(field[locale.code])) {
    return field[locale.code]
  } else if (
    !_.isUndefined(locale.code) &&
    !_.isUndefined(localesFallback[locale.code])
  ) {
    return getLocalizedField({
      field,
      locale: { code: localesFallback[locale.code] },
      localesFallback,
    })
  } else {
    return null
  }
}
const buildFallbackChain = locales => {
  const localesFallback = {}
  _.each(
    locales,
    locale => (localesFallback[locale.code] = locale.fallbackCode)
  )
  return localesFallback
}
const makeGetLocalizedField = ({ locale, localesFallback }) => field =>
  getLocalizedField({ field, locale, localesFallback })

exports.getLocalizedField = getLocalizedField
exports.buildFallbackChain = buildFallbackChain

const makeId = ({ spaceId, id, currentLocale, defaultLocale, type }) => {
  const normalizedType = type.startsWith(`Deleted`)
    ? type.substring(`Deleted`.length)
    : type
  return currentLocale === defaultLocale
    ? `${spaceId}___${id}___${normalizedType}`
    : `${spaceId}___${id}___${normalizedType}___${currentLocale}`
}

exports.makeId = makeId

const makeMakeId = ({ currentLocale, defaultLocale, createNodeId }) => (
  spaceId,
  id,
  type
) => createNodeId(makeId({ spaceId, id, currentLocale, defaultLocale, type }))

exports.buildEntryList = ({ contentTypeItems, mergedSyncData }) => {
  // Create buckets for each type sys.id that we care about (we will always want an array for each, even if its empty)
  const map = new Map(
    contentTypeItems.map(contentType => [contentType.sys.id, []])
  )
  // Now fill the buckets. Ignore entries for which there exists no bucket. (Not sure if that ever happens)
  mergedSyncData.entries.map(entry => {
    const arr = map.get(entry.sys.contentType.sys.id)
    if (arr) {
      arr.push(entry)
    }
  })
  // Order is relevant, must map 1:1 to contentTypeItems array
  return contentTypeItems.map(contentType => map.get(contentType.sys.id))
}

exports.buildResolvableSet = ({
  entryList,
  existingNodes = [],
  assets = [],
}) => {
  const resolvable = new Set()
  existingNodes.forEach(node => {
    // We need to add only root level resolvable (assets and entries)
    // Derived nodes (markdown or JSON) will be recreated if needed.
    resolvable.add(`${node.contentful_id}___${node.sys.type}`)
  })

  entryList.forEach(entries => {
    entries.forEach(entry =>
      resolvable.add(`${entry.sys.id}___${entry.sys.type}`)
    )
  })

  assets.forEach(assetItem =>
    resolvable.add(`${assetItem.sys.id}___${assetItem.sys.type}`)
  )

  return resolvable
}

exports.buildForeignReferenceMap = ({
  contentTypeItems,
  entryList,
  resolvable,
  defaultLocale,
  space,
  useNameForId,
}) => {
  const foreignReferenceMap = {}
  contentTypeItems.forEach((contentTypeItem, i) => {
    // Establish identifier for content type
    //  Use `name` if specified, otherwise, use internal id (usually a natural-language constant,
    //  but sometimes a base62 uuid generated by Contentful, hence the option)
    let contentTypeItemId
    if (useNameForId) {
      contentTypeItemId = contentTypeItem.name.toLowerCase()
    } else {
      contentTypeItemId = contentTypeItem.sys.id.toLowerCase()
    }

    entryList[i].forEach(entryItem => {
      const entryItemFields = entryItem.fields
      Object.keys(entryItemFields).forEach(entryItemFieldKey => {
        if (entryItemFields[entryItemFieldKey]) {
          const entryItemFieldValue =
            entryItemFields[entryItemFieldKey][defaultLocale]
          // If this is an array of single reference object
          // add to the reference map, otherwise ignore.
          if (Array.isArray(entryItemFieldValue)) {
            if (
              entryItemFieldValue[0] &&
              entryItemFieldValue[0].sys &&
              entryItemFieldValue[0].sys.type &&
              entryItemFieldValue[0].sys.id
            ) {
              entryItemFieldValue.forEach(v => {
                const key = `${v.sys.id}___${v.sys.linkType || v.sys.type}`
                // Don't create link to an unresolvable field.
                if (!resolvable.has(key)) {
                  return
                }

                if (!foreignReferenceMap[key]) {
                  foreignReferenceMap[key] = []
                }
                foreignReferenceMap[key].push({
                  name: `${contentTypeItemId}___NODE`,
                  id: entryItem.sys.id,
                  spaceId: space.sys.id,
                  type: entryItem.sys.type,
                })
              })
            }
          } else if (
            entryItemFieldValue?.sys?.type &&
            entryItemFieldValue.sys.id
          ) {
            const key = `${entryItemFieldValue.sys.id}___${
              entryItemFieldValue.sys.linkType || entryItemFieldValue.sys.type
            }`
            // Don't create link to an unresolvable field.
            if (!resolvable.has(key)) {
              return
            }

            if (!foreignReferenceMap[key]) {
              foreignReferenceMap[key] = []
            }
            foreignReferenceMap[key].push({
              name: `${contentTypeItemId}___NODE`,
              id: entryItem.sys.id,
              spaceId: space.sys.id,
              type: entryItem.sys.type,
            })
          }
        }
      })
    })
  })

  return foreignReferenceMap
}

function prepareTextNode(id, node, key, text) {
  const str = _.isString(text) ? text : ``
  const textNode = {
    id,
    parent: node.id,
    raw: str,
    internal: {
      type: `ContentfulNodeTypeText`,
      mediaType: `text/markdown`,
      content: str,
      // entryItem.sys.updatedAt is source of truth from contentful
      contentDigest: node.updatedAt,
    },
  }

  return textNode
}

function prepareLocationNode(id, node, key, data) {
  const { lat, lon } = data
  const LocationNode = {
    id,
    parent: node.id,
    lat,
    lon,
    internal: {
      type: `ContentfulNodeTypeLocation`,
      // entryItem.sys.updatedAt is source of truth from contentful
      contentDigest: node.updatedAt,
    },
  }

  return LocationNode
}

function prepareJSONNode(id, node, key, content) {
  const str = JSON.stringify(content)
  const JSONNode = {
    ...(_.isPlainObject(content) ? { ...content } : { content: content }),
    id,
    parent: node.id,
    children: [],
    internal: {
      type: `ContentfulNodeTypeJSON`,
      mediaType: `application/json`,
      content: str,
      // entryItem.sys.updatedAt is source of truth from contentful
      contentDigest: node.updatedAt,
    },
  }

  node.children = node.children.concat([id])

  return JSONNode
}

exports.createNodesForContentType = ({
  contentTypeItem,
  restrictedNodeFields,
  conflictFieldPrefix,
  entries,
  createNode,
  createNodeId,
  createContentDigest,
  getNode,
  resolvable,
  foreignReferenceMap,
  defaultLocale,
  locales,
  space,
  useNameForId,
  pluginConfig,
}) => {
  // Establish identifier for content type
  //  Use `name` if specified, otherwise, use internal id (usually a natural-language constant,
  //  but sometimes a base62 uuid generated by Contentful, hence the option)
  let contentTypeItemId
  if (useNameForId) {
    contentTypeItemId = contentTypeItem.name
  } else {
    contentTypeItemId = contentTypeItem.sys.id
  }

  const createNodePromises = []
  locales.forEach(locale => {
    const localesFallback = buildFallbackChain(locales)
    const mId = makeMakeId({
      currentLocale: locale.code,
      defaultLocale,
      createNodeId,
    })
    const getField = makeGetLocalizedField({
      locale,
      localesFallback,
    })

    // Warn about any field conflicts
    const conflictFields = []
    contentTypeItem.fields.forEach(contentTypeItemField => {
      const fieldName = contentTypeItemField.id
      if (restrictedNodeFields.includes(fieldName)) {
        console.log(
          `Restricted field found for ContentType ${contentTypeItemId} and field ${fieldName}. Prefixing with ${conflictFieldPrefix}.`
        )
        conflictFields.push(fieldName)
      }
    })

    const childrenNodes = []

    // First create nodes for each of the entries of that content type
    const entryNodes = entries
      .map(entryItem => {
        const entryNodeId = mId(
          space.sys.id,
          entryItem.sys.id,
          entryItem.sys.type
        )

        const existingNode = getNode(entryNodeId)
        if (existingNode?.internal?.contentDigest === entryItem.sys.updatedAt) {
          // The Contentful model has `.sys.updatedAt` leading for an entry. If the updatedAt value
          // of an entry did not change, then we can trust that none of its children were changed either.
          return null
        }

        // Get localized fields.
        const entryItemFields = _.mapValues(entryItem.fields, (v, k) => {
          const fieldProps = contentTypeItem.fields.find(
            field => field.id === k
          )

          const localizedField = fieldProps.localized
            ? getField(v)
            : v[defaultLocale]

          return localizedField
        })

        // Prefix any conflicting fields
        // https://github.com/gatsbyjs/gatsby/pull/1084#pullrequestreview-41662888
        conflictFields.forEach(conflictField => {
          entryItemFields[`${conflictFieldPrefix}${conflictField}`] =
            entryItemFields[conflictField]
          delete entryItemFields[conflictField]
        })

        // Add linkages to other nodes based on foreign references
        Object.keys(entryItemFields).forEach(entryItemFieldKey => {
          if (entryItemFields[entryItemFieldKey]) {
            const entryItemFieldValue = entryItemFields[entryItemFieldKey]
            if (Array.isArray(entryItemFieldValue)) {
              if (
                entryItemFieldValue[0] &&
                entryItemFieldValue[0].sys &&
                entryItemFieldValue[0].sys.type &&
                entryItemFieldValue[0].sys.id
              ) {
                // Check if there are any values in entryItemFieldValue to prevent
                // creating an empty node field in case when original key field value
                // is empty due to links to missing entities
                const resolvableEntryItemFieldValue = entryItemFieldValue
                  .filter(function (v) {
                    return resolvable.has(
                      `${v.sys.id}___${v.sys.linkType || v.sys.type}`
                    )
                  })
                  .map(function (v) {
                    return mId(
                      space.sys.id,
                      v.sys.id,
                      v.sys.linkType || v.sys.type
                    )
                  })
                if (resolvableEntryItemFieldValue.length !== 0) {
                  entryItemFields[
                    `${entryItemFieldKey}___NODE`
                  ] = resolvableEntryItemFieldValue
                }

                delete entryItemFields[entryItemFieldKey]
              }
            } else if (
              entryItemFieldValue &&
              entryItemFieldValue.sys &&
              entryItemFieldValue.sys.type &&
              entryItemFieldValue.sys.id
            ) {
              if (
                resolvable.has(
                  `${entryItemFieldValue.sys.id}___${
                    entryItemFieldValue.sys.linkType ||
                    entryItemFieldValue.sys.type
                  }`
                )
              ) {
                entryItemFields[`${entryItemFieldKey}___NODE`] = mId(
                  space.sys.id,
                  entryItemFieldValue.sys.id,
                  entryItemFieldValue.sys.linkType ||
                    entryItemFieldValue.sys.type
                )
              }
              delete entryItemFields[entryItemFieldKey]
            }
          }
        })

        // Add reverse linkages if there are any for this node
        const foreignReferences =
          foreignReferenceMap[`${entryItem.sys.id}___${entryItem.sys.type}`]
        if (foreignReferences) {
          foreignReferences.forEach(foreignReference => {
            const existingReference = entryItemFields[foreignReference.name]
            if (existingReference) {
              // If the existing reference is a string, we're dealing with a
              // many-to-one reference which has already been recorded, so we can
              // skip it. However, if it is an array, add it:
              if (Array.isArray(existingReference)) {
                entryItemFields[foreignReference.name].push(
                  mId(
                    foreignReference.spaceId,
                    foreignReference.id,
                    foreignReference.type
                  )
                )
              }
            } else {
              // If there is one foreign reference, there can be many.
              // Best to be safe and put it in an array to start with.
              entryItemFields[foreignReference.name] = [
                mId(
                  foreignReference.spaceId,
                  foreignReference.id,
                  foreignReference.type
                ),
              ]
            }
          })
        }

        // Create sys node
        const sysId = createNodeId(`${entryNodeId}.sys`)

        const sys = {
          id: sysId,
          // parent___NODE: entryNodeId,
          type: entryItem.sys.type,
          internal: {
            type: `ContentfulSys`,
            contentDigest: entryItem.sys.updatedAt,
          },
        }

        // Revision applies to entries, assets, and content types
        if (entryItem.sys.revision) {
          sys.revision = entryItem.sys.revision
        }

        // Content type applies to entries only
        if (entryItem.sys.contentType) {
          sys.contentType___NODE = createNodeId(contentTypeItemId)
        }

        childrenNodes.push(sys)

        // Create actual entry node
        let entryNode = {
          id: entryNodeId,
          spaceId: space.sys.id,
          contentful_id: entryItem.sys.id,
          createdAt: entryItem.sys.createdAt,
          updatedAt: entryItem.sys.updatedAt,
          parent: contentTypeItemId,
          children: [],
          internal: {
            type: `${makeTypeName(contentTypeItemId)}`,
          },
          sys___NODE: sysId,
        }

        // Replace text fields with text nodes so we can process their markdown
        // into HTML.
        Object.keys(entryItemFields).forEach(entryItemFieldKey => {
          // Ignore fields with "___node" as they're already handled
          // and won't be a text field.
          if (entryItemFieldKey.includes(`___`)) {
            return
          }

          const fieldType = contentTypeItem.fields.find(
            f =>
              (restrictedNodeFields.includes(f.id)
                ? `${conflictFieldPrefix}${f.id}`
                : f.id) === entryItemFieldKey
          ).type
          if (fieldType === `Text`) {
            const textNodeId = createNodeId(
              `${entryNodeId}${entryItemFieldKey}TextNode`
            )

            // The Contentful model has `.sys.updatedAt` leading for an entry. If the updatedAt value
            // of an entry did not change, then we can trust that none of its children were changed either.
            // (That's why child nodes use the updatedAt of the parent node as their digest, too)
            const existingNode = getNode(textNodeId)
            if (
              existingNode?.internal?.contentDigest !== entryItem.sys.updatedAt
            ) {
              const textNode = prepareTextNode(
                textNodeId,
                entryNode,
                entryItemFieldKey,
                entryItemFields[entryItemFieldKey],
                createNodeId
              )

              childrenNodes.push(textNode)
            }

            entryItemFields[`${entryItemFieldKey}___NODE`] = textNodeId
            delete entryItemFields[entryItemFieldKey]
          } else if (
            fieldType === `RichText` &&
            _.isPlainObject(entryItemFields[entryItemFieldKey])
          ) {
            const fieldValue = entryItemFields[entryItemFieldKey]

            const rawReferences = []

            // Locate all Contentful Links within the rich text data
            const traverse = obj => {
              for (const k in obj) {
                const v = obj[k]
                if (v && v.sys && v.sys.type === `Link`) {
                  rawReferences.push(v)
                } else if (v && typeof v === `object`) {
                  traverse(v)
                }
              }
            }

            traverse(fieldValue)

            // Build up resolvable reference list
            const resolvableReferenceIds = new Set()
            rawReferences
              .filter(function (v) {
                return resolvable.has(
                  `${v.sys.id}___${v.sys.linkType || v.sys.type}`
                )
              })
              .forEach(function (v) {
                resolvableReferenceIds.add(
                  mId(space.sys.id, v.sys.id, v.sys.linkType || v.sys.type)
                )
              })

            const richTextNodeId = createNodeId(
              `${entryNodeId}.${entryItemFieldKey}.richText`
            )

            const raw = stringify(fieldValue)
            const richTextNode = {
              id: richTextNodeId,
              raw,
              references___NODE: [...resolvableReferenceIds],
              internal: {
                type: `ContentfulNodeTypeRichText`,
                contentDigest: createContentDigest(raw),
              },
            }
            childrenNodes.push(richTextNode)
            delete entryItemFields[entryItemFieldKey]
            entryItemFields[`${entryItemFieldKey}___NODE`] = richTextNodeId
          } else if (
            fieldType === `Object` &&
            _.isPlainObject(entryItemFields[entryItemFieldKey])
          ) {
            const jsonNodeId = createNodeId(
              `${entryNodeId}${entryItemFieldKey}JSONNode`
            )

            // The Contentful model has `.sys.updatedAt` leading for an entry. If the updatedAt value
            // of an entry did not change, then we can trust that none of its children were changed either.
            // (That's why child nodes use the updatedAt of the parent node as their digest, too)
            const existingNode = getNode(jsonNodeId)
            if (
              existingNode?.internal?.contentDigest !== entryItem.sys.updatedAt
            ) {
              const jsonNode = prepareJSONNode(
                jsonNodeId,
                entryNode,
                entryItemFieldKey,
                entryItemFields[entryItemFieldKey],
                createNodeId
              )
              childrenNodes.push(jsonNode)
            }

            entryItemFields[`${entryItemFieldKey}___NODE`] = jsonNodeId
            delete entryItemFields[entryItemFieldKey]
          } else if (
            fieldType === `Object` &&
            _.isArray(entryItemFields[entryItemFieldKey])
          ) {
            entryItemFields[`${entryItemFieldKey}___NODE`] = []

            entryItemFields[entryItemFieldKey].forEach((obj, i) => {
              const jsonNodeId = createNodeId(
                `${entryNodeId}${entryItemFieldKey}${i}JSONNode`
              )

              // The Contentful model has `.sys.updatedAt` leading for an entry. If the updatedAt value
              // of an entry did not change, then we can trust that none of its children were changed either.
              // (That's why child nodes use the updatedAt of the parent node as their digest, too)
              const existingNode = getNode(jsonNodeId)
              if (
                existingNode?.internal?.contentDigest !==
                entryItem.sys.updatedAt
              ) {
                const jsonNode = prepareJSONNode(
                  jsonNodeId,
                  entryNode,
                  entryItemFieldKey,
                  obj,
                  createNodeId,
                  i
                )
                childrenNodes.push(jsonNode)
              }

              entryItemFields[`${entryItemFieldKey}___NODE`].push(jsonNodeId)
            })

            delete entryItemFields[entryItemFieldKey]
          } else if (fieldType === `Location`) {
            const locationNodeId = createNodeId(
              `${entryNodeId}${entryItemFieldKey}Location`
            )

            // The Contentful model has `.sys.updatedAt` leading for an entry. If the updatedAt value
            // of an entry did not change, then we can trust that none of its children were changed either.
            // (That's why child nodes use the updatedAt of the parent node as their digest, too)
            const existingNode = getNode(locationNodeId)
            if (
              existingNode?.internal?.contentDigest !== entryItem.sys.updatedAt
            ) {
              const textNode = prepareLocationNode(
                locationNodeId,
                entryNode,
                entryItemFieldKey,
                entryItemFields[entryItemFieldKey],
                createNodeId
              )

              childrenNodes.push(textNode)
            }

            entryItemFields[`${entryItemFieldKey}___NODE`] = locationNodeId
            delete entryItemFields[entryItemFieldKey]
          }
        })

        entryNode = {
          ...entryItemFields,
          ...entryNode,
          node_locale: locale.code,
        }

        // The content of an entry is guaranteed to be updated if and only if the .sys.updatedAt field changed
        entryNode.internal.contentDigest = entryItem.sys.updatedAt

        // Link tags
        if (pluginConfig.get(`enableTags`)) {
          entryNode.metadata = {
            tags___NODE: entryItem.metadata.tags.map(tag =>
              createNodeId(`ContentfulTag__${space.sys.id}__${tag.sys.id}`)
            ),
          }
        }

        return entryNode
      })
      .filter(Boolean)

    // Create a node for each content type
    const contentTypeNode = {
      id: createNodeId(contentTypeItemId),
      name: contentTypeItem.name,
      displayField: contentTypeItem.displayField,
      description: contentTypeItem.description,
      internal: {
        type: `${makeTypeName(`ContentType`)}`,
      },
    }

    // The content of an entry is guaranteed to be updated if and only if the .sys.updatedAt field changed
    contentTypeNode.internal.contentDigest = contentTypeItem.sys.updatedAt

    createNodePromises.push(createNode(contentTypeNode))
    entryNodes.forEach(entryNode => {
      createNodePromises.push(createNode(entryNode))
    })
    childrenNodes.forEach(entryNode => {
      createNodePromises.push(createNode(entryNode))
    })
  })

  return createNodePromises
}

exports.createAssetNodes = ({
  assetItem,
  createNode,
  createNodeId,
  defaultLocale,
  locales,
  space,
}) => {
  const createNodePromises = []
  locales.forEach(locale => {
    const localesFallback = buildFallbackChain(locales)
    const mId = makeMakeId({
      currentLocale: locale.code,
      defaultLocale,
      createNodeId,
    })
    const getField = makeGetLocalizedField({
      locale,
      localesFallback,
    })

    const assetNode = {
      contentful_id: assetItem.sys.id,
      spaceId: space.sys.id,
      id: mId(space.sys.id, assetItem.sys.id, assetItem.sys.type),
      createdAt: assetItem.sys.createdAt,
      updatedAt: assetItem.sys.updatedAt,
      parent: null,
      children: [],
      file: assetItem.fields.file ? getField(assetItem.fields.file) : null,
      title: assetItem.fields.title ? getField(assetItem.fields.title) : ``,
      description: assetItem.fields.description
        ? getField(assetItem.fields.description)
        : ``,
      node_locale: locale.code,
      internal: {
        type: `${makeTypeName(`Asset`)}`,
      },
      sys: {
        type: assetItem.sys.type,
      },
    }

    // Revision applies to entries, assets, and content types
    if (assetItem.sys.revision) {
      assetNode.sys.revision = assetItem.sys.revision
    }

    // The content of an entry is guaranteed to be updated if and only if the .sys.updatedAt field changed
    assetNode.internal.contentDigest = assetItem.sys.updatedAt

    createNodePromises.push(createNode(assetNode))
  })

  return createNodePromises
}
