const axios = require('axios')
const Queue = require('better-queue')
const querystring = require('querystring')

class WordPressSource {
  static defaultOptions () {
    return {
      baseUrl: '',
      perPage: 100,
      concurrent: 10,
      routes: {},
      typeName: 'WordPress'
    }
  }

  constructor (options, { context, source }) {
    this.options = options
    this.context = context
    this.source = source
  }

  async apply () {
    const { baseUrl, perPage, concurrent } = this.options
    let { routes } = this.options

    const restUrl = `${baseUrl.replace(/\/+$/, '')}/wp-json/wp/v2`
    const restBases = { posts: {}, taxonomies: {}}

    try {
      await axios.get(restUrl)
    } catch (err) {
      throw new Error(`Failed to fetch baseUrl ${baseUrl}`)
    }

    routes = {
      post: '/:year/:month/:day/:slug',
      post_tag: '/tag/:slug',
      category: '/category/:slug',
      ...routes
    }

    // add prefix to post and term id's since
    // they will share the same node store
    const makePostId = id => this.source.makeUid(`post-${id}`)
    const makeTermId = id => this.source.makeUid(`term-${id}`)

    const { data: types } = await axios.get(`${restUrl}/types`)
    const { data: taxonomies } = await axios.get(`${restUrl}/taxonomies`)

    for (const typeName in types) {
      const options = types[typeName]

      if (typeName === 'attachment') continue

      restBases.posts[typeName] = options.rest_base

      this.source.addType(typeName, {
        name: options.name,
        route: routes[typeName]
      })
    }

    for (const typeName in taxonomies) {
      const options = taxonomies[typeName]
      restBases.taxonomies[typeName] = options.rest_base

      this.source.addType(typeName, {
        name: options.name,
        route: routes[typeName]
      })
    }

    for (const typeName in restBases.posts) {
      const restBase = restBases.posts[typeName]
      const endpoint = `${restUrl}/${restBase}`
      const posts = await fetchPaged(endpoint, { perPage, concurrent })

      for (const post of posts) {
        const refs = {}

        // add references if post has any taxonomy rest bases as properties
        for (const typeName in restBases.taxonomies) {
          const propName = restBases.taxonomies[typeName]
          if (post.hasOwnProperty(propName)) {
            refs[typeName] = post[propName].map(id => {
              return makeTermId(id)
            })
          }
        }

        this.source.addNode(post.type, {
          _id: makePostId(post.id),
          title: post.title ? post.title.rendered : '',
          date: post.date ? new Date(post.date) : null,
          slug: post.slug,
          fields: {
            content: post.content ? post.content.rendered : '',
            excerpt: post.excerpt ? post.excerpt.rendered : ''
          },
          refs
        })
      }
    }

    for (const typeName in restBases.taxonomies) {
      const restBase = restBases.taxonomies[typeName]
      const endpoint = `${restUrl}/${restBase}`
      const terms = await fetchPaged(endpoint, { perPage, concurrent })

      for (const term of terms) {
        this.source.addNode(term.taxonomy, {
          _id: makeTermId(term.id),
          slug: term.slug,
          title: term.name,
          fields: {
            count: term.count
          }
        })
      }
    }
  }
}

async function taskHandler (task, cb) {
  try {
    const response = await axios.get(task.id)
    cb(null, response)
  } catch (err) {
    cb(err)
  }
}

function fetchPaged (url, options = {}) {
  return new Promise(async (resolve, reject) => {
    const query = querystring.stringify({ per_page: options.perPage })
    const res = await axios.get(`${url}?${query}`)
    const totalItems = parseInt(res.headers['x-wp-total'], 10)
    const totalPages = parseInt(res.headers['x-wp-totalpages'], 10)

    try {
      res.data = ensureArrayData(url, res.data)
    } catch (err) {
      return reject(err)
    }

    if (!totalItems || totalPages <= 1) {
      return resolve(res.data)
    }

    const queue = new Queue(taskHandler, {
      concurrent: options.concurrent
    })

    for (let page = 2; page <= totalPages; page++) {
      const query = querystring.stringify({ per_page: options.perPage, page })
      queue.push({ id: `${url}?${query}` })
    }

    queue.on('task_failed', (id, err) => {
      reject(`${id} failed with error: ${err}`)
      queue.destroy()
    })

    queue.on('task_finish', (id, { data }) => {
      try {
        res.data.push(...ensureArrayData(id, data))
      } catch (err) {
        return reject(err)
      }
    })

    queue.on('drain', () => {
      resolve(res.data)
    })
  })
}

function ensureArrayData (url, data) {
  if (!Array.isArray(data)) {
    try {
      data = JSON.parse(data)
    } catch (err) {
      throw new Error(
        `Failed to fetch ${url}\n` +
        `Expected JSON response but got:\n` +
        `${data.trim().substring(0, 150)}...\n`
      )
    }
  }
  return data
}

module.exports = WordPressSource
