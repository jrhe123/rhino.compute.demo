const compute = require('compute-rhino3d')
const rhino3dm = require("rhino3dm")

const solveGH = (input, definitionPath) => {
  return new Promise((resolve, reject) => {
    let computeServerTiming
    compute.url = process.env.RHINO_COMPUTE_URL
    compute.apiKey = process.env.RHINO_COMPUTE_KEY
    let trees = []
    for (let [key, value] of Object.entries(input)) {
      let param = new compute.Grasshopper.DataTree(key)
      param.append([0], Array.isArray(value) ? value : [value])
      trees.push(param)
    }
    // call compute server
    compute.Grasshopper.evaluateDefinition(definitionPath, trees, false)
      .then((response) => {
        if(!response.ok) {
          reject(new Error(response.statusText))
        } else {
          computeServerTiming = response.headers
          return response.text()
        }
      })
      .then((result) => {
        resolve({
          computeServerTiming,
          result
        })
      })
      .catch((error) => {
        reject(error)
      })
  })
}

const generateRhinoObj = (responseStr) => {
  const responseJson = JSON.parse(responseStr)
  const values = responseJson.values
  return new Promise((resolve, reject) => {
    rhino3dm().then((rhino) => {
      var rhinoMeshObject
      var rhinoMaterialObject
      // for each output (RH_OUT:*)...
      for ( let i = 0; i < values.length; i ++ ) {
        // ...iterate through data tree structure...
        for (const path in values[i].InnerTree) {
          const branch = values[i].InnerTree[path]
          // ...and for each branch...
          for( let j = 0; j < branch.length; j ++) {
            if (branch[j].type === 'Rhino.Geometry.Mesh') {
              rhinoMeshObject = _decodeItem(branch[j], rhino)
            } else if (branch[j].type === 'Rhino.Display.DisplayMaterial') {
              rhinoMaterialObject = _decodeItem(branch[j], rhino)
            }
          }
        }
      }
      resolve({
        rhinoMeshObject,
        rhinoMaterialObject,
      })
    })
  })
}

const generateBuffer = (rhinoMesh, materialObject) => {
  // Hack in nodejs
  const THREE = require('three');
  const Canvas = require('canvas');
  const { Blob, FileReader } = require('vblob');
  const XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;

  global.window = global;
  global.Blob = Blob;
  global.XMLHttpRequest = XMLHttpRequest;
  global.FileReader = FileReader;
  global.THREE = THREE;
  global.document = {
    createElement: (nodeName) => {
      if (nodeName !== 'canvas') throw new Error(`Cannot create node ${nodeName}`);
      const canvas = new Canvas(256, 256);
      return canvas;
    }
  };
  // End of hack

  // Three loader
  let loader = new THREE.BufferGeometryLoader()
  var geometry = loader.parse(rhinoMesh.toThreejsJSON())

  // Material
  var threeMaterial = new THREE.MeshBasicMaterial()
  var diffuse = `rgb(${materialObject.Diffuse})`
  const color = new THREE.Color(diffuse);
  threeMaterial.color = color

  // Mesh
  let newMesh = new THREE.Mesh(geometry, threeMaterial)
  newMesh.name = "sku"
  newMesh.material.name = "sku"

  return new Promise((resolve, reject) => {
    require('three/examples/js/exporters/GLTFExporter');
    const exporter = new THREE.GLTFExporter();
    const options = {
      trs: false,
      onlyVisible: true,
      truncateDrawRange: true,
      binary: true,
      maxTextureSize: 4096 || Infinity // To prevent NaN value
    };
    exporter.parse(newMesh, (result) => {
      if ( result instanceof ArrayBuffer ) {
        let blob = new Blob( [ result ], { type: 'application/octet-stream' } )
        var reader = new FileReader()
        reader.onload = function(){
          var buffer = Buffer.from(reader.result)
          resolve(buffer)
        }
        reader.onloadend = function(){
          releaseHack()
        }
        reader.readAsArrayBuffer(blob)
      }
    }, options)
  })
}

const releaseHack = () => {
  global.window = undefined;
  global.Blob = undefined;
  global.XMLHttpRequest = undefined;
  global.FileReader = undefined;
  global.THREE = undefined;
  global.document = undefined
}

module.exports = {
  solveGH,
  generateRhinoObj,
  generateBuffer,
}


const _decodeItem = (item, rhino) => {
  const data = JSON.parse(item.data)
  if (item.type === 'System.String') {
    // hack for draco meshes
    try {
        return rhino.DracoCompression.decompressBase64String(data)
    } catch {} // ignore errors (maybe the string was just a string...)
  } else if (item.type === 'Rhino.Display.DisplayMaterial') {
    return data
  } else if (typeof data === 'object') {
    return rhino.CommonObject.decode(data)
  }
  return null
}