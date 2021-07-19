const express = require('express')
let router = express.Router()

router.post('/glb', function(req, res) {

    console.log("hit here")

})

module.exports = router