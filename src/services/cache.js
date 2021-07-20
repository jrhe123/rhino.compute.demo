const NodeCache = require('node-cache')
const cache = new NodeCache()

const getCache = (mc, cacheKey) => {
  if(mc === null){
    // use node cache
    const result = cache.get(cacheKey)
    return result !== undefined ? result : null
  } else {
    // use memcached
    if(mc !== null) {
      mc.get(cacheKey, function(err, val) {
        if(err == null) {
          return val
        }
      })
    }
  }
  return null
}

const setCache = (mc, cacheKey, result) => {
  if(mc !== null) {
    //set memcached
    mc.set(cacheKey, result, {expires:0}, function(err, val){
      if(err) console.log(err)
    })
  } else {
    //set node-cache
    cache.set(cacheKey, result)
  }
}

module.exports = {
  getCache,
  setCache
}