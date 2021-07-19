const fs = require('fs')
const path = require('path')
const md5File = require('md5-file')

function getFilesSync(dir) {
  return fs.readdirSync(dir)
}

function registerDefinitions() {
  let files = getFilesSync(path.join(__dirname, 'files/'))
  let definitions = []
  files.forEach( file => {
    if(file.includes('.gh') || file.includes('.ghx')) {
      const fullPath = path.join(__dirname, 'files/' + file)
      const hash = md5File.sync(fullPath)
      definitions.push({
        name: file,
        id: hash,
        path: fullPath
      })
    }
  })
  return definitions
}

module.exports = { registerDefinitions }
