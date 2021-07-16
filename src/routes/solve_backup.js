const express = require('express')
const router = express.Router()
const compute = require('compute-rhino3d')
const {performance} = require('perf_hooks')

const NodeCache = require('node-cache')
const cache = new NodeCache()

const memjs = require('memjs')
let mc = null

let definition = null

// In case you have a local memached server
// process.env.MEMCACHIER_SERVERS = '127.0.0.1:11211'
if(process.env.MEMCACHIER_SERVERS !== undefined) {
  mc = memjs.Client.create(process.env.MEMCACHIER_SERVERS, {
    failover: true,  // default: false
    timeout: 1,      // default: 0.5 (seconds)
    keepAlive: true  // default: false
  })
}

function computeParams (req, res, next){

  console.log("gh: ", req.params.definition)
  console.log("call computeParams")

  compute.url = process.env.RHINO_COMPUTE_URL
  compute.apiKey = process.env.RHINO_COMPUTE_KEY
  next()
}

/**
 * Collect request parameters
 * This middleware function stores request parameters in the same manner no matter the request method
 */

function collectParams (req, res, next){

  console.log("call collectParams")

  res.locals.params = {}
  switch (req.method){
  case 'HEAD':
  case 'GET':
    res.locals.params.definition = req.params.definition
    res.locals.params.inputs = req.query
    break
  case 'POST':
    res.locals.params = req.body
    break
  default:
    next()
    break
  }

  let definitionName = res.locals.params.definition
  if (definitionName===undefined)
    definitionName = res.locals.params.pointer

  definition = req.app.get('definitions').find(o => o.name === definitionName)
  if(!definition)
    throw new Error('Definition not found on server.')

  //replace definition data with object that includes definition hash
  res.locals.params.definition = definition

  next()
}

/**
 * Check cache
 * This middleware function checks if a cache value exist for a cache key
 */

function checkCache (req, res, next){

  console.log("call checkCache")

  const key = {}
  key.definition = { 'name': res.locals.params.definition.name, 'id': res.locals.params.definition.id }
  key.inputs = res.locals.params.inputs
  if (res.locals.params.values!==undefined)
    key.inputs = res.locals.params.values
  res.locals.cacheKey = JSON.stringify(key)
  res.locals.cacheResult = null

  if(mc === null){
    // use node cache
    //console.log('using node-cache')
    const result = cache.get(res.locals.cacheKey)
    res.locals.cacheResult = result !== undefined ? result : null
    next()
  } else {
    // use memcached
    //console.log('using memcached')
    if(mc !== null) {
      mc.get(res.locals.cacheKey, function(err, val) {
        if(err == null) {
          res.locals.cacheResult = val
        }
        next()
      })
    }
  }
}

/**
 * Solve GH definition
 * This is the core "workhorse" function for the appserver. Client apps post
 * json data to the appserver at this endpoint and that json is passed on to
 * compute for solving with Grasshopper.
 */

function commonSolve (req, res, next){

  console.log("call commonSolve")

  const timePostStart = performance.now()
  // set general headers
  // what is the proper max-age, 31536000 = 1 year, 86400 = 1 day
  res.setHeader('Cache-Control', 'public, max-age=31536000')
  res.setHeader('Content-Type', 'application/json')

  if(res.locals.cacheResult !== null) {
    //send
    //console.log(res.locals.cacheResult)
    const timespanPost = Math.round(performance.now() - timePostStart)
    res.setHeader('Server-Timing', `cacheHit;dur=${timespanPost}`)


    if (req.query.testMode) {
      testMode(res.locals.cacheResult)
    }


    res.send(res.locals.cacheResult)
    return
  } else {
    //solve
    //console.log('solving')
    // set parameters
    let trees = []
    if(res.locals.params.inputs !== undefined) { //TODO: handle no inputs
      for (let [key, value] of Object.entries(res.locals.params.inputs)) {
        let param = new compute.Grasshopper.DataTree(key)
        param.append([0], Array.isArray(value) ? value : [value])
        trees.push(param)
      }
    }
    if(res.locals.params.values !== undefined) {
      for (let index=0; index<res.locals.params.values.length; index++) {
        let param = new compute.Grasshopper.DataTree('')
        param.data = res.locals.params.values[index]
        trees.push(param)
      }
    }

    let fullUrl = req.protocol + '://' + req.get('host')
    let definitionPath = `${fullUrl}/definition/${definition.id}`

    // console.log("definitionPath: ", definitionPath)

    const timePreComputeServerCall = performance.now()
    let computeServerTiming = null

    // call compute server
    compute.Grasshopper.evaluateDefinition(definitionPath, trees, false).then( (response) => {

      // console.log("compute response: ", response)

      // Throw error if response not ok
      if(!response.ok) {
        throw new Error(response.statusText)
      } else {
        computeServerTiming = response.headers
        return response.text()
      }
    }).then( (result) => {


      if (req.query.testMode) {
        testMode(result)
      }


      const timeComputeServerCallComplete = performance.now()
      let computeTimings = computeServerTiming.get('server-timing')
      let sum = 0
      computeTimings.split(',').forEach(element => {
        let t = element.split('=')[1].trim()
        sum += Number(t)
      })
      const timespanCompute = timeComputeServerCallComplete - timePreComputeServerCall
      const timespanComputeNetwork = Math.round(timespanCompute - sum)
      const timespanSetup = Math.round(timePreComputeServerCall - timePostStart)
      const timing = `setup;dur=${timespanSetup}, ${computeTimings}, network;dur=${timespanComputeNetwork}`
        
      if(mc !== null) {
        //set memcached
        mc.set(res.locals.cacheKey, result, {expires:0}, function(err, val){
          console.log(err)
          console.log(val)
        })
      } else {
        //set node-cache
        cache.set(res.locals.cacheKey, result)
      }

      res.setHeader('Server-Timing', timing)
      res.send(result)
    }).catch( (error) => { 
      next(error)
    })
  }
}

// Collect middleware functions into a pipeline
const pipeline = [computeParams, collectParams, checkCache, commonSolve]

// Handle different http methods
router.head('/:definition',pipeline) // do we need HEAD?
router.get('/:definition', pipeline)
router.post('/', pipeline)

module.exports = router



function decodeItem(item, rhino) {
  const data = JSON.parse(item.data)
  if (item.type === 'System.String') {
    // hack for draco meshes
    try {
        return rhino.DracoCompression.decompressBase64String(data)
    } catch {} // ignore errors (maybe the string was just a string...)
  } else if (typeof data === 'object') {
    return rhino.CommonObject.decode(data)
  }
  return null
}

function testMode2(rhinoMesh){
  const THREE = require('three');
  const Canvas = require('canvas');
  const { Blob, FileReader } = require('vblob');
  const XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
  const URL = require('url').URL;

  // // Patch global scope to imitate browser environment.
  global.window = global;
  global.Blob = Blob;
  global.XMLHttpRequest = XMLHttpRequest;
  global.URL = URL;
  global.FileReader = FileReader;
  global.THREE = THREE;
  global.document = {
    createElement: (nodeName) => {
      if (nodeName !== 'canvas') throw new Error(`Cannot create node ${nodeName}`);
      const canvas = new Canvas(256, 256);
      // This isn't working — currently need to avoid toBlob(), so export to embedded .gltf not .glb.
      // canvas.toBlob = function () {
      //   return new Blob([this.toBuffer()]);
      // };
      return canvas;
    }
  };


  let loader = new THREE.BufferGeometryLoader()
  var geometry = loader.parse(rhinoMesh.toThreejsJSON())
  // var threeMaterial = new THREE.MeshNormalMaterial()
  let newMesh = new THREE.Mesh(geometry)
  newMesh.name = "my_mesh"
  newMesh.material.name = "my_mesh_material"


  console.log("newMesh created")


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
      let filePath = "test_13.glb"
      let blob = new Blob( [ result ], { type: 'application/octet-stream' } )

      var reader = new FileReader()
      reader.onload = function(){
        var buffer = new Buffer(reader.result)
        const fs = require('fs')
        fs.writeFile(filePath, buffer, {}, (err, res) => {
          if(err){
              console.log("err: ", err)
              return
          }
          console.log('saved!!!!!!!!')
        })
      }
      reader.readAsArrayBuffer(blob)
    } else {
      console.log("!!! other format")
    }
  }, options)

}


function testMode(responseStr){

  const { Blob, FileReader } = require('vblob');

  const responseJson = JSON.parse(responseStr)
  const values = responseJson.values

  const rhino3dm = require("rhino3dm")
  rhino3dm().then((rhino) => {

    // console.log("rhino: ", rhino)
    var rhinoMeshObject
    var doc = new rhino.File3dm()
    // for each output (RH_OUT:*)...
    for ( let i = 0; i < values.length; i ++ ) {
      // ...iterate through data tree structure...
      for (const path in values[i].InnerTree) {
        const branch = values[i].InnerTree[path]
        // ...and for each branch...
        for( let j = 0; j < branch.length; j ++) {
          // ...load rhino geometry into doc
          const rhinoObject = decodeItem(branch[j], rhino)

          // test
          rhinoMeshObject = rhinoObject
          // test

          if (rhinoObject !== null) {
            doc.objects().add(rhinoObject, null)
          }
        }
      }
    }

    // var meshThreejsJson = rhinoMeshObject.toThreejsJSON()
    testMode2(rhinoMeshObject)
    

    // // write rhino doc to "blob"
    // const bytes = doc.toByteArray()
    // console.log("bytes: ", bytes)

    // const blob = new Blob([bytes], {type: "application/octect-stream"})
    // let filePath = "test_1.3dm"
    // var reader = new FileReader()
    // reader.onload = function(){
    //   var buffer = new Buffer(reader.result)
    //   const fs = require('fs')
    //   fs.writeFile(filePath, buffer, {}, (err, res) => {
    //     if(err){
    //         console.log("err: ", err)
    //         return
    //     }
    //     console.log('saved!!!!!!!!')
    //   })
    // }
    // reader.readAsArrayBuffer(blob)

  })

  


  return


  // const THREE = require('three');
  // const Canvas = require('canvas');
  // const { Blob, FileReader } = require('vblob');
  // const XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;

  // // Patch global scope to imitate browser environment.
  // global.window = global;
  // global.Blob = Blob;
  // global.XMLHttpRequest = XMLHttpRequest;
  // global.FileReader = FileReader;
  // global.THREE = THREE;
  // global.document = {
  //   createElement: (nodeName) => {
  //     if (nodeName !== 'canvas') throw new Error(`Cannot create node ${nodeName}`);
  //     const canvas = new Canvas(256, 256);
  //     // This isn't working — currently need to avoid toBlob(), so export to embedded .gltf not .glb.
  //     // canvas.toBlob = function () {
  //     //   return new Blob([this.toBuffer()]);
  //     // };
  //     return canvas;
  //   }
  // };

  // const responseJson = JSON.parse(responseStr)
  // const values = responseJson.values
  // const str = values[0].InnerTree['{0;0;0}'][0].data
  // const data = JSON.parse(str)
  
  // let filePath = "test_2.glb"
  // let blob = new Blob( [ data ], { type: 'application/octet-stream' } )

  // var reader = new FileReader()
  // reader.onload = function(){
  //   var buffer = new Buffer(reader.result)
  //   const fs = require('fs')
  //   fs.writeFile(filePath, buffer, {}, (err, res) => {
  //     if(err){
  //         console.log("err: ", err)
  //         return
  //     }
  //     console.log('saved!!!!!!!!')
  //   })
  // }
  // reader.readAsArrayBuffer(blob)
  
  // return;


  // const result = _base64ToArrayBuffer(data)

  // if ( result instanceof ArrayBuffer ) {
  //   let filePath = "test_2.glb"
  //   let blob = new Blob( [ result ], { type: 'application/octet-stream' } )

  //   var reader = new FileReader()
  //   reader.onload = function(){
  //     var buffer = new Buffer(reader.result)
  //     const fs = require('fs')
  //     fs.writeFile(filePath, buffer, {}, (err, res) => {
  //       if(err){
  //           console.log("err: ", err)
  //           return
  //       }
  //       console.log('saved!!!!!!!!')
  //     })
  //   }
  //   reader.readAsArrayBuffer(blob)
  // } else {
  //   console.log("!!! other format")
  // }
  






  return;

  // const responseJson = JSON.parse(responseStr)
  // const values = responseJson.values
  // const str = values[0].InnerTree['{0;0;0}'][0].data
  // const data = JSON.parse(str)
  // const arr = _base64ToArrayBuffer(data)

        
  // const THREE = require('three');
  // const Canvas = require('canvas');
  // const { Blob, FileReader } = require('vblob');
  // const XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
  // const URL = require('url').URL;

  // // Patch global scope to imitate browser environment.
  // global.window = global;
  // global.Blob = Blob;
  // global.XMLHttpRequest = XMLHttpRequest;
  // global.URL = URL;
  // global.URL.createObjectURL = jest.fn();
  // global.FileReader = FileReader;
  // global.THREE = THREE;
  // global.document = {
  //   createElement: (nodeName) => {
  //     if (nodeName !== 'canvas') throw new Error(`Cannot create node ${nodeName}`);
  //     const canvas = new Canvas(256, 256);
  //     // This isn't working — currently need to avoid toBlob(), so export to embedded .gltf not .glb.
  //     // canvas.toBlob = function () {
  //     //   return new Blob([this.toBuffer()]);
  //     // };
  //     return canvas;
  //   }
  // };

  // require('three/examples/js/loaders/3DMLoader');
  // const loader = new THREE.Rhino3dmLoader();
  // loader.setLibraryPath('https://cdn.jsdelivr.net/npm/rhino3dm@0.15.0-beta/')
  // loader.parse(arr, function (object) {
  //   // object.traverse(child => {
  //   //   if (child.isMesh) {
  //   //     console.log("child: ", child)
  //   //   }
  //   // }, false)
  // }, function (error) {
  //   console.log("error: ", error)
  // })

  // require('three/examples/js/exporters/GLTFExporter');
  // const exporter = new THREE.GLTFExporter();   



  // set up loader for converting the results to threejs
  // const loader = new Rhino3dmLoader()
  // loader.setLibraryPath('https://cdn.jsdelivr.net/npm/rhino3dm@0.15.0-beta/')
  // loader.parse(arr, function (object) {
  //   object.traverse(child => {
  //     if (child.isMesh) {
  //       console.log("child: ", child)
  //     }
  //   }, false)
  // })
}

function _base64ToArrayBuffer(base64) {
  var atob = require('atob')
  var binary_string = atob(base64);
  var len = binary_string.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}


function customMesh () {
  const THREE = require('three');
  const Canvas = require('canvas');
  const { Blob, FileReader } = require('vblob');
  const XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;

  // Patch global scope to imitate browser environment.
  global.window = global;
  global.Blob = Blob;
  global.XMLHttpRequest = XMLHttpRequest;
  global.FileReader = FileReader;
  global.THREE = THREE;
  global.document = {
    createElement: (nodeName) => {
      if (nodeName !== 'canvas') throw new Error(`Cannot create node ${nodeName}`);
      const canvas = new Canvas(256, 256);
      // This isn't working — currently need to avoid toBlob(), so export to embedded .gltf not .glb.
      // canvas.toBlob = function () {
      //   return new Blob([this.toBuffer()]);
      // };
      return canvas;
    }
  };

  const geometry = new THREE.BoxGeometry( 30, 30, 30 );
  const material = new THREE.MeshBasicMaterial( { color: 0x0fff77 } );
  const mesh = new THREE.Mesh( geometry, material );

  require('three/examples/js/exporters/GLTFExporter');
  const exporter = new THREE.GLTFExporter();
  const options = {
    trs: false,
    onlyVisible: true,
    truncateDrawRange: true,
    binary: true,
    maxTextureSize: 4096 || Infinity // To prevent NaN value
  };
  exporter.parse(mesh, (result) => {
    // console.log("result: ", result)
    if ( result instanceof ArrayBuffer ) {
      let filePath = "test_1.glb"
      let blob = new Blob( [ result ], { type: 'application/octet-stream' } )

      var reader = new FileReader()
      reader.onload = function(){
        var buffer = new Buffer(reader.result)
        const fs = require('fs')
        fs.writeFile(filePath, buffer, {}, (err, res) => {
          if(err){
              console.log("err: ", err)
              return
          }
          console.log('saved!!!!!!!!')
        })
      }
      reader.readAsArrayBuffer(blob)
    } else {
      console.log("!!! other format")
    }
  }, options)
}


function customRhino3dm(){
  return new Promise(async (resolve, reject) => {

    let responseJson = JSON.parse(responseStr)
    let data = JSON.parse(responseJson.values[0].InnerTree['{0}'][0].data)

    // const THREE = require('three');
    // const Canvas = require('canvas');
    // const { Blob, FileReader } = require('vblob');
    // const XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
  
    // // Patch global scope to imitate browser environment.
    // global.window = global;
    // global.Blob = Blob;
    // global.XMLHttpRequest = XMLHttpRequest;
    // global.FileReader = FileReader;
    // global.THREE = THREE;
    // global.document = {
    //   createElement: (nodeName) => {
    //     if (nodeName !== 'canvas') throw new Error(`Cannot create node ${nodeName}`);
    //     const canvas = new Canvas(256, 256);
    //     // This isn't working — currently need to avoid toBlob(), so export to embedded .gltf not .glb.
    //     // canvas.toBlob = function () {
    //     //   return new Blob([this.toBuffer()]);
    //     // };
    //     return canvas;
    //   }
    // };

    // let loader = new THREE.BufferGeometryLoader()

    const rhino3dm = require("rhino3dm")
    rhino3dm().then((rhino) => {
      // const sphere = new rhino.Sphere([1,2,3,], 12)
      // console.log("sphere: ", sphere.radius)

      let mesh = rhino.DracoCompression.decompressBase64String(data)
      console.log("mesh: ", mesh)

      // var geometry = loader.parse(mesh.toThreejsJSON())
      // console.log("geometry: ", geometry)
    })
  })
}