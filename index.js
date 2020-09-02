const AWS = require('aws-sdk')
const { parse } = require('parse5')
const fetch = require('node-fetch')
const uuid = require('uuid').v4
const s3 = new AWS.S3()

const DOMAIN_REGEX = /^(http:\/\/www\.|https:\/\/www\.|http:\/\/|https:\/\/)?([a-z0-9]+\.)*[a-z0-9]+\.[a-z]+/

function getImageExtension(url) {
  const extension = url.split(/\#|\?/)[0].split('.').pop()

  if (extension) {
    return extension.trim()
  }

  return 'jpg'
}

function getMimeTypeFromExtension(extension) {
  const whiteList = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
  }

  return whiteList[extension] || 'image/jpeg'
}

function parseImagesFromDomNode(node) {
  if (node.tagName === 'img') {
    const imageSource = node.attrs.find(
      (attr) => attr.name === 'src' || attr.name === 'node-src'
    )

    if (imageSource == null || imageSource.value.startsWith('data:')) {
      return []
    }

    return imageSource.value
  }

  if (!node.childNodes) {
    return []
  }

  return node.childNodes.reduce(
    (acc, childNode) => acc.concat(parseImagesFromDomNode(childNode)),
    []
  )
}

function parseTextsFromDomNode(node) {
  if (node.tagName === 'script') {
    return []
  }

  if (node.tagName === 'style') {
    return []
  }

  if (node.nodeName === '#text') {
    const trimmedRawText = node.value.trim()

    if (trimmedRawText.startsWith('<iframe')) {
      return []
    }

    return trimmedRawText.length < 10 ? [] : trimmedRawText
  }

  if (!node.childNodes) {
    return []
  }

  return node.childNodes.reduce(
    (acc, childNode) => acc.concat(parseTextsFromDomNode(childNode)),
    []
  )
}

async function uploadImagesToS3(websiteId, images, domain, protocol) {
  for (const image of images) {
    try {
      const withoutRelativeUrl =
        image.startsWith('/') && !image.startsWith('//')
          ? `${domain}${image}`
          : image

      const withProtocol = withoutRelativeUrl.startsWith('//')
        ? `https:${withoutRelativeUrl}`
        : withoutRelativeUrl.startsWith('http')
        ? withoutRelativeUrl
        : `${protocol}${withoutRelativeUrl}`

      const response = await fetch(withProtocol)
      const extension = getImageExtension(image)
      const mimeType = getMimeTypeFromExtension(extension)

      try {
        await s3
          .upload({
            Bucket: 'lk2-stage',
            Key: `uploads/${websiteId}/images/${uuid()}.${extension}`,
            Body: response.body,
            ACL: 'public-read',
            ContentType: mimeType,
          })
          .promise()
      } catch (error) {
        console.log(
          `[--- ERROR UPLOADING THIRD-PARTY IMAGE TO S3 WITH URL ${image} ---]`
        )
      }
    } catch (error) {
      console.log(
        `[--- ERROR GETTING THIRD-PARTY IMAGE CONTENT WITH URL ${image} ---]`
      )
    }
  }
}

async function uploadTextsToDB(pageId, snippets) {
  const apiUrl = `${process.env.API_URL}/v1/public/pages/${pageId}/snippets`
  console.log('API_URL', apiUrl)
  console.log('SNIPPETS', JSON.stringify(snippets))

  try {
    await fetch(apiUrl, {
      method: 'post',
      body: JSON.stringify(snippets),
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.log(error)
    return `Unable to upload texts to DB for page with ID: ${pageId}`
  }
}

exports.handler = async (event) => {
  const {
    pageId: { stringValue: pageId },
    websiteId: { stringValue: websiteId },
    seo: { stringValue: seo },
    images: { stringValue: images },
    texts: { stringValue: texts },
  } = event.Records[0].messageAttributes

  const bareUrl = event.Records[0].messageAttributes.url.stringValue
  const url =
    bareUrl.startsWith('http://') || bareUrl.startsWith('https://')
      ? bareUrl
      : `https://${bareUrl}`

  console.log('URL', url)
  console.log('PAGEID', pageId)
  console.log('WEBSITEID', websiteId)
  console.log('SEO', seo)
  console.log('IMAGES', images)
  console.log('TEXTS', texts)

  const matches = url.match(DOMAIN_REGEX)
  const domain = matches && matches[0]

  if (!domain) {
    console.log(`Provided external URL is incorrect: ${url}`)
    return `Provided external URL is incorrect: ${url}`
  }

  const relativeUrl = new URL(url).pathname

  try {
    // Query for page HTML content
    const htmlResponse = await fetch(url)

    const htmlContent = await htmlResponse.text()

    // Parse title, description and body content
    const rootNode = parse(htmlContent)

    const htmlNode = rootNode.childNodes.find((node) => node.tagName === 'html')

    if (!htmlNode) {
      console.log(`Missing HTML node for URL: ${url}`)
      return `Missing HTML node for URL: ${url}`
    }

    const bodyNode = htmlNode.childNodes.find((node) => node.tagName === 'body')

    if (!bodyNode) {
      console.log(`Missing BODY node for URL: ${url}`)
      return `Missing BODY node for URL: ${url}`
    }

    if (seo === 'true') {
      const headNode = htmlNode.childNodes.find(
        (node) => node.tagName === 'head'
      )

      if (!headNode) {
        console.log(`Missing HEAD node for URL: ${url}`)
        return `Missing HEAD node for URL: ${url}`
      }

      const titleNode = headNode.childNodes.find(
        (node) => node.tagName === 'title'
      )

      if (!titleNode) {
        console.log(`Missing TITLE node for URL: ${url}`)
        return `Missing TITLE node for URL: ${url}`
      }

      const textNodeInTitleNode = titleNode.childNodes.find(
        (node) => node.nodeName === '#text'
      )

      if (!textNodeInTitleNode) {
        console.log(`Page title missing for: ${url}`)
        return `Page title missing for: ${url}`
      }

      const pageTitle = textNodeInTitleNode.value

      const metaNodes = headNode.childNodes.filter(
        (node) => node.tagName === 'meta'
      )

      if (!metaNodes) {
        console.log(`META nodes missing for: ${url}`)
        return `META nodes missing for: ${url}`
      }

      const descriptionNode = metaNodes.find((node) => {
        return (
          node.attrs.find(
            (attr) => attr.name === 'name' && attr.value === 'description'
          ) !== undefined
        )
      })

      if (!descriptionNode) {
        console.log(`META node with description missing for: ${url}`)
      }

      const pageDescription = !descriptionNode
        ? ''
        : descriptionNode.attrs.find((attr) => attr.name === 'content').value

      console.log('TITLE', pageTitle)
      console.log('DESCRIPTION', pageDescription)

      const body = {
        id: pageId,
        title: pageTitle,
        description: pageDescription,
        url: relativeUrl,
      }

      const apiUrl = `${process.env.API_URL}/v1/public/pages`

      try {
        await fetch(apiUrl, {
          method: 'put',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error) {
        console.log(error)
        return `Unable to update page with ID: ${pageId}`
      }
    }

    if (texts === 'true') {
      const texts = parseTextsFromDomNode(bodyNode)

      await uploadTextsToDB(pageId, texts)
    }

    if (images === 'true') {
      const images = parseImagesFromDomNode(bodyNode)
      const protocol = url.startsWith('https://') ? 'https://' : 'http://'

      await uploadImagesToS3(websiteId, images, domain, protocol)
    }
  } catch (error) {
    console.log(error)
    return `Unable to fetch the provided URL: ${url}`
  }

  console.log(`Successfully processed messages.`)
  return `Successfully processed messages.`
}
