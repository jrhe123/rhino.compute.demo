const fs = require('fs')
const path = require('path')

const saveGlbFile = (buffer, fileName) => {
  return new Promise((resolve, reject) => {
    const pathName = path.join(__dirname, "../glb/", fileName)
    fs.writeFile(pathName, buffer, {}, (err, res) => {
      if(err){
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

module.exports = {
  saveGlbFile
}