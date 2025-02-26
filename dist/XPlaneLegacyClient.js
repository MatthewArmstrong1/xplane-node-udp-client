const dgram = require('dgram')

const endianNess = () => {
  const uInt32 = new Uint32Array([0x11223344])
  const uInt8 = new Uint8Array(uInt32.buffer)

  if (uInt8[0] === 0x44) {
    return 'Little Endian'
  }
  if (uInt8[0] === 0x11) {
    return 'Big Endian'
  }
  return 'Maybe mixed-endian?'
}

// @ts-ignore
const BIG_ENDIAN = endianNess() === 'Big Endian'

let client

module.exports = class XPlaneClient {
  constructor(settings) {
    const self = this

    this.host = settings.host || '127.0.0.1'
    this.port = settings.port || 49000
    this.debug = settings.debug || false
    this.dataRefs = []
    this.stringDataRefs = []
    this.index = 0
    this.initialized = false

    client = null

    this.checkConnection = () => !client && this.initConnection()
    this.isConnected = () => client
    this.connectionInfo = () => client
  }

  _sendBuffer(data) {
    this.initConnection()

    // sending msg

    // console.log('sending:', data);
    client.send(data, this.port, this.host, function cb(error /* , bytes */) {
      if (error) {
        client.close()
        client = null
        console.error(`XPlaneClient failed to send data X-Plane: ${error}`)
      }
    })
  }

  requestDataRef(dataRef, timesPerSecond, callback = undefined) {
    let index = this.dataRefs.length

    // Check if dataref is already being monitored
    for (let i = 0; i < this.dataRefs.length; i++) {
      if (this.dataRefs[i].dataRef === dataRef) {
        index = i
        if (this.debug) {
          console.log(`Using existing dataref ${dataRef} at index ${index}`)
        }
      }
    }

    this.dataRefs[index] = {
      dataRef,
      timesPerSecond,
      callback,
      value: null
    }

    // Calculate buffer size dynamically based on dataRef length
    const maxDataRefLength = 400 // X-Plane max length
    const dataRefBuffer = Buffer.from(dataRef, 'utf8')

    if (dataRefBuffer.length > maxDataRefLength) {
      console.warn(`DataRef exceeds max length and will be truncated: ${dataRef}`)
    }

    // Create buffer (5 bytes header + 8 bytes index/freq + DataRef string + null terminator)
    const buffer = Buffer.alloc(5 + 4 + 4 + maxDataRefLength)
    buffer.write('RREF', 0, 4) // Write header

    if (BIG_ENDIAN) {
      buffer.writeInt32BE(timesPerSecond, 5) // dref_freq
      buffer.writeInt32BE(index, 9) // drefSenderIndex
    } else {
      buffer.writeInt32LE(timesPerSecond, 5) // dref_freq
      buffer.writeInt32LE(index, 9) // drefSenderIndex
    }

    // Write DataRef string and ensure null termination
    dataRefBuffer.copy(buffer, 13, 0, Math.min(dataRefBuffer.length, maxDataRefLength - 1))
    buffer[13 + Math.min(dataRefBuffer.length, maxDataRefLength - 1)] = 0 // Null terminator

    this._sendBuffer(buffer)
  }

  async requestStringDataRef(dataRef, stringLength, callback = undefined) { // stringLength is the length of the string (bytes). eg: aircraft livery can be 1024 bytes long. a good place to find example values for this is the following repo: https://github.com/MaxFerretti/XPlaneConnector/blob/master/XPlaneConnector/XPlaneConnector.DataRefs/DataRefs.cs
    let frequency = 1
    let index = this.dataRefs.length

    // Check if dataref is already being monitored
    for (let i = 0; i < this.dataRefs.length; i++) {
      if (this.dataRefs[i].dataRef === dataRef) {
        index = i
        if (this.debug) {
          console.log(`Using existing dataref ${dataRef} at index ${index}`)
        }
      }
    }

    let finalisedString = ''

    this.dataRefs[index] = {
      dataRef,
      frequency,
      callback,
      value: null
    }

    for (let i = 0; i < stringLength; i++) {
      let dataRefHandler = dataRef + '[' + i + ']'
  
      const value = await new Promise((resolve) => {
        this.requestDataRef(dataRefHandler, frequency, (_, value) => {
          resolve(value)
        })
      })
  
      if (value === 0) {
        break
      }
  
      finalisedString += String.fromCharCode(value)
    }

    if (callback !== undefined) {
      callback(dataRef, finalisedString)
    }
  }

  setDataRef(dataRef, value) {
    const buffer = Buffer.alloc(509, 0x20)
    buffer.write('DREF', 0, 4)
    buffer.writeInt8(0x00, 4)
    if (BIG_ENDIAN) {
      buffer.writeFloatBE(value, 5) // var
    } else {
      buffer.writeFloatLE(value, 5) // var
    }
    buffer.write(dataRef, 9)
    buffer.writeInt8(0x00, 9 + dataRef.length) // 0-byte terminate the string
    this._sendBuffer(buffer)
  }

  sendCommand(command) {
    const buffer = Buffer.alloc(5 + command.length + 1)
    buffer.write('CMND', 0, 4)
    buffer.write(command, 5, command.length)
    this._sendBuffer(buffer)
  }

  initConnection() {
    const self = this

    if (client === null) {
      client = dgram.createSocket('udp4')
    } else {
      return
    }

    client.on('listening', () => {
      const address = client.address()
      if (this.debug) {
        console.log(`XPlaneClient listening on ${address.address}:${address.port}`)
      }
    })

    client.on('error', (err) => {
      console.error(`XPlaneClient error:\n${err.stack}`)
      client.close()
      client = null
    })

    // eslint-disable-next-line no-unused-vars
    client.on('message', (msg, info) => {
      const command = msg.toString('utf8', 0, 4)
      // console.log('Received %d bytes from %s:%d',msg.length, info.address, info.port);
      // console.log('Data received from server : ', command, msg );//+ msg.toString());

      if (command === 'RPOS') {
        // 69 bytes:
        // 0: the four chars RPOS and a NULL.
        // let dat_lon     = command.readDoubleLE( 5 );  // longitude of the aircraft in X-Plane of course, in degrees
        // let dat_lat     = command.readDoubleLE( 13 ); // latitude
        // let dat_ele     = command.readDoubleLE( 21 ); // elevation above sea level in meters
        // let y_agl_mtr   = command.readFloatLE( 29 );  //elevation above the terrain in meters
        // let veh_the_loc = command.readFloatLE( 33 );  // pitch, degrees
        // let veh_psi_loc = command.readFloatLE( 37 );  // true heading, in degrees
        // let veh_phi_loc = command.readFloatLE( 41 );  // roll, in degrees
        // let vx_wrl      = command.readFloatLE( 45 );  // speed in the x, EAST, direction, in meters per second
        // let vy_wrl      = command.readFloatLE( 49 );  // speed in the y, UP, direction, in meters per second
        // let vz_wrl      = command.readFloatLE( 53 );  // speed in the z, SOUTH, direction, in meters per second
        // let Prad        = command.readFloatLE( 57 );  // roll rate in radians per second
        // let Qrad        = command.readFloatLE( 61 );  // pitch rate in radians per second
        // let Rrad        = command.readFloatLE( 65 );  // yah rate in radians per second
        // console.log( "dat_lon", dat_lon, "dat_lat", dat_lat, "dat_ele", dat_ele, "y_agl_mtr", y_agl_mtr );
      } else if (command === 'RREF') {
        const numrefs = (msg.length - 5) / 8
        let offset = 5

        for (let i = 0; i < numrefs; i += 1) {
          const drefSenderIndex = BIG_ENDIAN ? msg.readInt32BE(offset) : msg.readInt32LE(offset)
          const drefFltValue = BIG_ENDIAN
            ? msg.readFloatBE(offset + 4)
            : msg.readFloatLE(offset + 4)

          // eslint-disable-next-line no-prototype-builtins
          if (self.dataRefs.hasOwnProperty(drefSenderIndex)) {
            const dataRef = self.dataRefs[drefSenderIndex]

            // Only propagate the dataref value if it has changed from what it was before
            // TODO: make it possible to request all events even if not changed (more overhead)
            if (dataRef.value !== drefFltValue) {
              if (this.debug) {
                console.log(
                  `[${i + 1}/${numrefs}] new value for dataRef ${
                    dataRef.dataRef
                  } is ${drefFltValue}`
                )
              }

              // Store old value so we can detect changes to the value
              dataRef.value = drefFltValue

              if (dataRef.callback !== undefined) {
                dataRef.callback(dataRef.dataRef, drefFltValue)
              }
            }
          } else if (this.debug) {
            console.log(
              `[${
                i + 1
              }/${numrefs}] value for unknown RREF index ${drefSenderIndex} is ${drefFltValue} (there must be a bug in the code somewhere!)`
            )
          }

          offset += 8
        }
      }
    })
  }
}
