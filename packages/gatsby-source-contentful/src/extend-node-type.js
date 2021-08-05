// @ts-check
const fs = require(`fs-extra`)
const path = require(`path`)

const sortBy = require(`lodash/sortBy`)
const {
  GraphQLObjectType,
  GraphQLBoolean,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLNonNull,
  GraphQLJSON,
  GraphQLList,
} = require(`gatsby/graphql`)
const { fetchContentfulAsset } = require(`./fetch-contentful-asset`)

const { stripIndent } = require(`common-tags`)
const qs = require(`qs`)

const {
  ImageFormatType,
  ImageResizingBehavior,
  ImageCropFocusType,
  ImageLayoutType,
  ImagePlaceholderType,
} = require(`./schemes`)

const { getCacheFolder } = require(`./config`)

// Promises that rejected should stay in this map. Otherwise remove promise and put their data in resolvedBase64Cache
const inFlightBase64Cache = new Map()
// This cache contains the resolved base64 fetches. This prevents async calls for promises that have resolved.
// The images are based on urls with w=20 and should be relatively small (<2kb) but it does stick around in memory
const resolvedBase64Cache = new Map()

// @see https://www.contentful.com/developers/docs/references/images-api/#/reference/resizing-&-cropping/specify-width-&-height
const CONTENTFUL_IMAGE_MAX_SIZE = 4000

// Supported Image Formats from https://www.contentful.com/developers/docs/references/images-api/#/reference/changing-formats/image-format
const validImageFormats = new Set([`jpg`, `png`, `webp`, `gif`])

const mimeTypeExtensions = new Map([
  [`image/jpeg`, `.jpg`],
  [`image/jpg`, `.jpg`],
  [`image/gif`, `.gif`],
  [`image/png`, `.png`],
  [`image/webp`, `.webp`],
])

exports.mimeTypeExtensions = mimeTypeExtensions

const isImage = image => mimeTypeExtensions.has(image?.file?.contentType)

// Note: this may return a Promise<body>, body (sync), or null
const getBase64Image = (imageProps, reporter, cache, CACHE_FOLDER) => {
  if (!imageProps) {
    return null
  }

  // We only support images that are delivered through Contentful's Image API
  if (imageProps.baseUrl.indexOf(`images.ctfassets.net`) === -1) {
    return null
  }

  const requestUrl = createUrl(imageProps.baseUrl, {
    width: 20,
    toFormat: `jpg`,
  })

  // Prefer to return data sync if we already have it
  const alreadyFetched = resolvedBase64Cache.get(requestUrl)
  if (alreadyFetched) {
    return alreadyFetched
  }

  // If already in flight for this url return the same promise as the first call
  const inFlight = inFlightBase64Cache.get(requestUrl)
  if (inFlight) {
    return inFlight
  }

  const loadImageAsBase64 = async () => {
    const filename = await fetchContentfulAsset({
      url: requestUrl,
      cache,
      reporter,
      cacheDir: CACHE_FOLDER,
    })

    const buffer = await fs.readFile(filename)

    return `data:image/jpeg;base64,${buffer.toString(`base64`)}`
  }

  const promise = loadImageAsBase64()

  inFlightBase64Cache.set(requestUrl, promise)

  return promise.then(body => {
    inFlightBase64Cache.delete(requestUrl)
    resolvedBase64Cache.set(requestUrl, body)
    return body
  })
}

const getBasicImageProps = (image, args) => {
  let aspectRatio
  if (args.width && args.height) {
    aspectRatio = args.width / args.height
  } else {
    aspectRatio =
      image.file.details.image.width / image.file.details.image.height
  }

  return {
    baseUrl: image.file.url,
    contentType: image.file.contentType,
    aspectRatio,
    width: image.file.details.image.width,
    height: image.file.details.image.height,
  }
}

const createUrl = (imgUrl, options = {}) => {
  // Convert to Contentful names and filter out undefined/null values.
  const urlArgs = {
    w: options.width || undefined,
    h: options.height || undefined,
    fl:
      options.toFormat === `jpg` && options.jpegProgressive
        ? `progressive`
        : undefined,
    q: options.quality || undefined,
    fm: options.toFormat || undefined,
    fit: options.resizingBehavior || undefined,
    f: options.cropFocus || undefined,
    bg: options.background || undefined,
  }

  // Note: qs will ignore keys that are `undefined`. `qs.stringify({a: undefined, b: null, c: 1})` => `b=&c=1`
  return `https:${imgUrl}?${qs.stringify(urlArgs)}`
}
exports.createUrl = createUrl

const generateImageSource = (
  filename,
  width,
  height,
  toFormat,
  _fit, // We use resizingBehavior instead
  { jpegProgressive, quality, cropFocus, backgroundColor, resizingBehavior }
) => {
  // Ensure we stay within Contentfuls Image API limits
  if (width > CONTENTFUL_IMAGE_MAX_SIZE) {
    height = Math.floor((height / width) * CONTENTFUL_IMAGE_MAX_SIZE)
    width = CONTENTFUL_IMAGE_MAX_SIZE
  }

  if (height > CONTENTFUL_IMAGE_MAX_SIZE) {
    width = Math.floor((width / height) * CONTENTFUL_IMAGE_MAX_SIZE)
    height = CONTENTFUL_IMAGE_MAX_SIZE
  }

  if (!validImageFormats.has(toFormat)) {
    console.warn(
      `[gatsby-source-contentful] Invalid image format "${toFormat}". Supported types are jpg, png and webp"`
    )
    return undefined
  }

  const src = createUrl(filename, {
    width,
    height,
    toFormat,
    resizingBehavior,
    background: backgroundColor?.replace(`#`, `rgb:`),
    quality,
    jpegProgressive,
    cropFocus,
  })
  return { width, height, format: toFormat, src }
}

exports.generateImageSource = generateImageSource

const fitMap = new Map([
  [`pad`, `contain`],
  [`fill`, `cover`],
  [`scale`, `fill`],
  [`crop`, `cover`],
  [`thumb`, `cover`],
])

const resolveFixed = (image, options) => {
  if (!isImage(image)) return null

  const { baseUrl, width, aspectRatio } = getBasicImageProps(image, options)

  let desiredAspectRatio = aspectRatio

  // If no dimension is given, set a default width
  if (options.width === undefined && options.height === undefined) {
    options.width = 400
  }

  // If only a height is given, calculate the width based on the height and the aspect ratio
  if (options.height !== undefined && options.width === undefined) {
    options.width = Math.round(options.height * desiredAspectRatio)
  }

  // If we're cropping, calculate the specified aspect ratio.
  if (options.width !== undefined && options.height !== undefined) {
    desiredAspectRatio = options.width / options.height
  }

  // If the user selected a height and width (so cropping) and fit option
  // is not set, we'll set our defaults
  if (options.width !== undefined && options.height !== undefined) {
    if (!options.resizingBehavior) {
      options.resizingBehavior = `fill`
    }
  }

  // Create sizes (in width) for the image. If the width of the
  // image is 800px, the sizes would then be: 800, 1200, 1600,
  // 2400.
  //
  // This is enough sizes to provide close to the optimal image size for every
  // device size / screen resolution
  let fixedSizes = []
  fixedSizes.push(options.width)
  fixedSizes.push(options.width * 1.5)
  fixedSizes.push(options.width * 2)
  fixedSizes.push(options.width * 3)
  fixedSizes = fixedSizes.map(Math.round)

  // Filter out sizes larger than the image's width and the contentful image's max size.
  const filteredSizes = fixedSizes.filter(size => {
    const calculatedHeight = Math.round(size / desiredAspectRatio)
    return (
      size <= CONTENTFUL_IMAGE_MAX_SIZE &&
      calculatedHeight <= CONTENTFUL_IMAGE_MAX_SIZE &&
      size <= width
    )
  })

  // Sort sizes for prettiness.
  const sortedSizes = sortBy(filteredSizes)

  // Create the srcSet.
  const srcSet = sortedSizes
    .map((size, i) => {
      let resolution
      switch (i) {
        case 0:
          resolution = `1x`
          break
        case 1:
          resolution = `1.5x`
          break
        case 2:
          resolution = `2x`
          break
        case 3:
          resolution = `3x`
          break
        default:
      }
      const h = Math.round(size / desiredAspectRatio)
      return `${createUrl(baseUrl, {
        ...options,
        width: size,
        height: h,
      })} ${resolution}`
    })
    .join(`,\n`)

  let pickedHeight
  let pickedWidth
  if (options.height) {
    pickedHeight = options.height
    pickedWidth = options.height * desiredAspectRatio
  } else {
    pickedHeight = options.width / desiredAspectRatio
    pickedWidth = options.width
  }

  return {
    aspectRatio: desiredAspectRatio,
    baseUrl,
    width: Math.round(pickedWidth),
    height: Math.round(pickedHeight),
    src: createUrl(baseUrl, {
      ...options,
      width: options.width,
    }),
    srcSet,
  }
}
exports.resolveFixed = resolveFixed

const resolveFluid = (image, options) => {
  if (!isImage(image)) return null

  const { baseUrl, width, aspectRatio } = getBasicImageProps(image, options)

  let desiredAspectRatio = aspectRatio

  // If no dimension is given, set a default maxWidth
  if (options.maxWidth === undefined && options.maxHeight === undefined) {
    options.maxWidth = 800
  }

  // If only a maxHeight is given, calculate the maxWidth based on the height and the aspect ratio
  if (options.maxHeight !== undefined && options.maxWidth === undefined) {
    options.maxWidth = Math.round(options.maxHeight * desiredAspectRatio)
  }

  // If we're cropping, calculate the specified aspect ratio.
  if (options.maxHeight !== undefined && options.maxWidth !== undefined) {
    desiredAspectRatio = options.maxWidth / options.maxHeight
  }

  // If the users didn't set a default sizes, we'll make one.
  if (!options.sizes) {
    options.sizes = `(max-width: ${options.maxWidth}px) 100vw, ${options.maxWidth}px`
  }

  // Create sizes (in width) for the image. If the max width of the container
  // for the rendered markdown file is 800px, the sizes would then be: 200,
  // 400, 800, 1200, 1600, 2400.
  //
  // This is enough sizes to provide close to the optimal image size for every
  // device size / screen resolution
  let fluidSizes = []
  fluidSizes.push(options.maxWidth / 4)
  fluidSizes.push(options.maxWidth / 2)
  fluidSizes.push(options.maxWidth)
  fluidSizes.push(options.maxWidth * 1.5)
  fluidSizes.push(options.maxWidth * 2)
  fluidSizes.push(options.maxWidth * 3)
  fluidSizes = fluidSizes.map(Math.round)

  // Filter out sizes larger than the image's maxWidth and the contentful image's max size.
  const filteredSizes = fluidSizes.filter(size => {
    const calculatedHeight = Math.round(size / desiredAspectRatio)
    return (
      size <= CONTENTFUL_IMAGE_MAX_SIZE &&
      calculatedHeight <= CONTENTFUL_IMAGE_MAX_SIZE &&
      size <= width
    )
  })

  // Add the original image (if it isn't already in there) to ensure the largest image possible
  // is available for small images.
  if (
    !filteredSizes.includes(width) &&
    width < CONTENTFUL_IMAGE_MAX_SIZE &&
    Math.round(width / desiredAspectRatio) < CONTENTFUL_IMAGE_MAX_SIZE
  ) {
    filteredSizes.push(width)
  }

  // Sort sizes for prettiness.
  const sortedSizes = sortBy(filteredSizes)

  // Create the srcSet.
  const srcSet = sortedSizes
    .map(width => {
      const h = Math.round(width / desiredAspectRatio)
      return `${createUrl(image.file.url, {
        ...options,
        width,
        height: h,
      })} ${Math.round(width)}w`
    })
    .join(`,\n`)

  return {
    aspectRatio: desiredAspectRatio,
    baseUrl,
    src: createUrl(baseUrl, {
      ...options,
      width: options.maxWidth,
      height: options.maxHeight,
    }),
    srcSet,
    sizes: options.sizes,
  }
}
exports.resolveFluid = resolveFluid

const resolveResize = (image, options) => {
  if (!isImage(image)) return null

  const { baseUrl, aspectRatio } = getBasicImageProps(image, options)

  // If no dimension is given, set a default width
  if (options.width === undefined && options.height === undefined) {
    options.width = 400
  }

  // If the user selected a height and width (so cropping) and fit option
  // is not set, we'll set our defaults
  if (options.width !== undefined && options.height !== undefined) {
    if (!options.resizingBehavior) {
      options.resizingBehavior = `fill`
    }
  }

  let pickedHeight = options.height
  let pickedWidth = options.width

  if (pickedWidth === undefined) {
    pickedWidth = pickedHeight * aspectRatio
  }

  if (pickedHeight === undefined) {
    pickedHeight = pickedWidth / aspectRatio
  }

  return {
    src: createUrl(image.file.url, options),
    width: Math.round(pickedWidth),
    height: Math.round(pickedHeight),
    aspectRatio,
    baseUrl,
  }
}

exports.resolveResize = resolveResize

const fixedNodeType = ({
  name,
  getTracedSVG,
  reporter,
  cache,
  CACHE_FOLDER,
}) => {
  return {
    type: new GraphQLObjectType({
      name: name,
      fields: {
        base64: {
          type: GraphQLString,
          resolve: imageProps =>
            getBase64Image(imageProps, reporter, cache, CACHE_FOLDER),
        },
        tracedSVG: {
          type: GraphQLString,
          resolve: getTracedSVG,
        },
        aspectRatio: { type: GraphQLFloat },
        width: { type: new GraphQLNonNull(GraphQLFloat) },
        height: { type: new GraphQLNonNull(GraphQLFloat) },
        src: { type: new GraphQLNonNull(GraphQLString) },
        srcSet: { type: new GraphQLNonNull(GraphQLString) },
        srcWebp: {
          type: GraphQLString,
          resolve({ image, options }) {
            if (
              image?.file?.contentType === `image/webp` ||
              options.toFormat === `webp`
            ) {
              return null
            }

            const fixed = resolveFixed(image, {
              ...options,
              toFormat: `webp`,
            })
            return fixed?.src
          },
        },
        srcSetWebp: {
          type: GraphQLString,
          resolve({ image, options }) {
            if (
              image?.file?.contentType === `image/webp` ||
              options.toFormat === `webp`
            ) {
              return null
            }

            const fixed = resolveFixed(image, {
              ...options,
              toFormat: `webp`,
            })
            return fixed?.srcSet
          },
        },
      },
    }),
    args: {
      width: {
        type: GraphQLInt,
      },
      height: {
        type: GraphQLInt,
      },
      quality: {
        type: GraphQLInt,
        defaultValue: 50,
      },
      toFormat: {
        type: ImageFormatType,
        defaultValue: ``,
      },
      resizingBehavior: {
        type: ImageResizingBehavior,
      },
      cropFocus: {
        type: ImageCropFocusType,
        defaultValue: null,
      },
      background: {
        type: GraphQLString,
        defaultValue: null,
      },
    },
    resolve(image, options, context) {
      const node = resolveFixed(image, options)
      if (!node) return null

      return {
        ...node,
        image,
        options,
        context,
      }
    },
  }
}

const fluidNodeType = ({
  name,
  getTracedSVG,
  reporter,
  cache,
  CACHE_FOLDER,
}) => {
  return {
    type: new GraphQLObjectType({
      name: name,
      fields: {
        base64: {
          type: GraphQLString,
          resolve: imageProps =>
            getBase64Image(imageProps, reporter, cache, CACHE_FOLDER),
        },
        tracedSVG: {
          type: GraphQLString,
          resolve: getTracedSVG,
        },
        aspectRatio: { type: new GraphQLNonNull(GraphQLFloat) },
        src: { type: new GraphQLNonNull(GraphQLString) },
        srcSet: { type: new GraphQLNonNull(GraphQLString) },
        srcWebp: {
          type: GraphQLString,
          resolve({ image, options }) {
            if (
              image?.file?.contentType === `image/webp` ||
              options.toFormat === `webp`
            ) {
              return null
            }

            const fluid = resolveFluid(image, {
              ...options,
              toFormat: `webp`,
            })
            return fluid?.src
          },
        },
        srcSetWebp: {
          type: GraphQLString,
          resolve({ image, options }) {
            if (
              image?.file?.contentType === `image/webp` ||
              options.toFormat === `webp`
            ) {
              return null
            }

            const fluid = resolveFluid(image, {
              ...options,
              toFormat: `webp`,
            })
            return fluid?.srcSet
          },
        },
        sizes: { type: new GraphQLNonNull(GraphQLString) },
      },
    }),
    args: {
      maxWidth: {
        type: GraphQLInt,
      },
      maxHeight: {
        type: GraphQLInt,
      },
      quality: {
        type: GraphQLInt,
        defaultValue: 50,
      },
      toFormat: {
        type: ImageFormatType,
        defaultValue: ``,
      },
      resizingBehavior: {
        type: ImageResizingBehavior,
      },
      cropFocus: {
        type: ImageCropFocusType,
        defaultValue: null,
      },
      background: {
        type: GraphQLString,
        defaultValue: null,
      },
      sizes: {
        type: GraphQLString,
      },
    },
    resolve(image, options, context) {
      const node = resolveFluid(image, options)
      if (!node) return null

      return {
        ...node,
        image,
        options,
        context,
      }
    },
  }
}

exports.extendNodeType = ({ type, cache, reporter, store }) => {
  if (type.name !== `ContentfulAsset`) {
    return {}
  }

  const CACHE_FOLDER = getCacheFolder({ store })

  const getTracedSVG = async args => {
    const { traceSVG } = require(`gatsby-plugin-sharp`)

    const { image, options } = args
    const {
      file: { contentType, url: imgUrl, fileName },
    } = image

    if (contentType.indexOf(`image/`) !== 0) {
      return null
    }

    const extension = mimeTypeExtensions.get(contentType)
    const url = createUrl(imgUrl, options)
    const name = path.basename(fileName, extension)

    const absolutePath = await fetchContentfulAsset({
      url,
      name,
      cache,
      reporter,
      cacheDir: CACHE_FOLDER,
      ext: extension,
    })

    return traceSVG({
      file: {
        internal: image.internal,
        name: image.file.fileName,
        extension,
        absolutePath,
      },
      args: { toFormat: `` },
      fileArgs: options,
    })
  }

  const getDominantColor = async ({ image, options }) => {
    let pluginSharp

    try {
      pluginSharp = require(`gatsby-plugin-sharp`)
    } catch (e) {
      console.error(
        `[gatsby-source-contentful] Please install gatsby-plugin-sharp`,
        e
      )
      return `rgba(0,0,0,0.5)`
    }

    try {
      const {
        file: { contentType, url: imgUrl, fileName },
      } = image

      if (contentType.indexOf(`image/`) !== 0) {
        return null
      }

      // 256px should be enough to properly detect the dominant color
      if (!options.width) {
        options.width = 256
      }

      const extension = mimeTypeExtensions.get(contentType)
      const url = createUrl(imgUrl, options)
      const name = path.basename(fileName, extension)

      const absolutePath = await fetchContentfulAsset({
        url,
        name,
        cache,
        reporter,
        cacheDir: CACHE_FOLDER,
        ext: extension,
      })

      if (!(`getDominantColor` in pluginSharp)) {
        console.error(
          `[gatsby-source-contentful] Please upgrade gatsby-plugin-sharp`
        )
        return `rgba(0,0,0,0.5)`
      }

      return pluginSharp.getDominantColor(absolutePath)
    } catch (e) {
      console.error(
        `[gatsby-source-contentful] Could not getDominantColor from image`,
        e
      )
      return `rgba(0,0,0,0.5)`
    }
  }

  const resolveGatsbyImageData = async (image, options) => {
    if (!isImage(image)) return null

    const { generateImageData } = require(`gatsby-plugin-image`)

    const { baseUrl, contentType, width, height } = getBasicImageProps(
      image,
      options
    )
    let [, format] = contentType.split(`/`)
    if (format === `jpeg`) {
      format = `jpg`
    }
    const imageProps = generateImageData({
      ...options,
      pluginName: `gatsby-source-contentful`,
      sourceMetadata: { width, height, format },
      filename: baseUrl,
      generateImageSource,
      fit: fitMap.get(options.resizingBehavior),
      options,
    })

    let placeholderDataURI = null

    if (options.placeholder === `dominantColor`) {
      imageProps.backgroundColor = await getDominantColor({
        image,
        options,
      })
    }

    if (options.placeholder === `blurred`) {
      placeholderDataURI = await getBase64Image(
        {
          baseUrl,
        },
        reporter,
        cache
      )
    }

    if (options.placeholder === `tracedSVG`) {
      placeholderDataURI = await getTracedSVG({
        image,
        options,
      })
    }

    if (placeholderDataURI) {
      imageProps.placeholder = { fallback: placeholderDataURI }
    }

    return imageProps
  }

  const fixedNode = fixedNodeType({
    name: `ContentfulFixed`,
    getTracedSVG,
    reporter,
    cache,
    CACHE_FOLDER,
  })

  const fluidNode = fluidNodeType({
    name: `ContentfulFluid`,
    getTracedSVG,
    reporter,
    cache,
    CACHE_FOLDER,
  })

  // gatsby-plugin-image
  const getGatsbyImageData = () => {
    const {
      getGatsbyImageFieldConfig,
    } = require(`gatsby-plugin-image/graphql-utils`)

    const fieldConfig = getGatsbyImageFieldConfig(resolveGatsbyImageData, {
      jpegProgressive: {
        type: GraphQLBoolean,
        defaultValue: true,
      },
      resizingBehavior: {
        type: ImageResizingBehavior,
      },
      cropFocus: {
        type: ImageCropFocusType,
      },
      quality: {
        type: GraphQLInt,
        defaultValue: 50,
      },
      layout: {
        type: ImageLayoutType,
        description: stripIndent`
            The layout for the image.
            CONSTRAINED: Resizes to fit its container, up to a maximum width, at which point it will remain fixed in size.
            FIXED: A static image size, that does not resize according to the screen width
            FULL_WIDTH: The image resizes to fit its container, even if that is larger than the source image.
            Pass a value to "sizes" if the container is not the full width of the screen.
        `,
      },
      placeholder: {
        type: ImagePlaceholderType,
        description: stripIndent`
            Format of generated placeholder image, displayed while the main image loads.
            BLURRED: a blurred, low resolution image, encoded as a base64 data URI (default)
            DOMINANT_COLOR: a solid color, calculated from the dominant color of the image.
            TRACED_SVG: a low-resolution traced SVG of the image.
            NONE: no placeholder. Set the argument "backgroundColor" to use a fixed background color.`,
      },
      formats: {
        type: GraphQLList(ImageFormatType),
        description: stripIndent`
            The image formats to generate. Valid values are AUTO (meaning the same format as the source image), JPG, PNG, and WEBP.
            The default value is [AUTO, WEBP], and you should rarely need to change this. Take care if you specify JPG or PNG when you do
            not know the formats of the source images, as this could lead to unwanted results such as converting JPEGs to PNGs. Specifying
            both PNG and JPG is not supported and will be ignored.
        `,
        defaultValue: [``, `webp`],
      },
    })

    fieldConfig.type = GraphQLJSON

    fieldConfig.args.placeholder.defaultValue = `dominantColor`
    fieldConfig.args.layout.defaultValue = `constrained`

    return fieldConfig
  }

  return {
    fixed: fixedNode,
    fluid: fluidNode,
    gatsbyImageData: getGatsbyImageData(),
    resize: {
      type: new GraphQLObjectType({
        name: `ContentfulResize`,
        fields: {
          base64: {
            type: GraphQLString,
            resolve: imageProps => getBase64Image(imageProps, reporter, cache),
          },
          tracedSVG: {
            type: GraphQLString,
            resolve: getTracedSVG,
          },
          src: { type: GraphQLString },
          width: { type: GraphQLInt },
          height: { type: GraphQLInt },
          aspectRatio: { type: GraphQLFloat },
        },
      }),
      args: {
        width: {
          type: GraphQLInt,
        },
        height: {
          type: GraphQLInt,
        },
        quality: {
          type: GraphQLInt,
          defaultValue: 50,
        },
        jpegProgressive: {
          type: GraphQLBoolean,
          defaultValue: true,
        },
        resizingBehavior: {
          type: ImageResizingBehavior,
        },
        toFormat: {
          type: ImageFormatType,
          defaultValue: ``,
        },
        cropFocus: {
          type: ImageCropFocusType,
          defaultValue: null,
        },
        background: {
          type: GraphQLString,
          defaultValue: null,
        },
      },
      resolve(image, options) {
        return resolveResize(image, options)
      },
    },
  }
}
