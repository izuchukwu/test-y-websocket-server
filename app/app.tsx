import express = require('express')
const port = process.env.PORT || 5000

const app = express() as express.Application

app.get('/', (req, res) => {
    console.log('request received')
    res.json({'hello': 'hi'})
})

app.listen(port, () => console.log(`Listening on ${port} ✨`))
