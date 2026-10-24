'use strict';

/**
 * Regression test: API v3 updates pushed raw Mongo docs into the runtime cache.
 *
 * Raw docs have no runtime fields (mills, endmills). The dataloader only re-reads
 * treatments created in the last 15 minutes, so when AAPS PATCHes a temp basal
 * later than that (when a long TBR ends), the mills-less copy stayed in the cache
 * and was sent to clients as an 'update'. The client then lost that temp basal
 * and drew the profile basal instead.
 */

const EventEmitter = require('events');
const { ObjectId } = require('mongodb');
require('should');

const MongoCachedCollection = require('../lib/api3/storage/mongoCachedCollection');
const calcDelta = require('../lib/data/calcdelta');

describe('API3 MongoCachedCollection runtime cache updates', function () {

  const MIN = 60 * 1000;
  let ctx, storage, mongoDocs;

  function rawTempBasal (minsAgo, duration, id) {
    const date = Date.now() - minsAgo * MIN;
    return {
      _id: new ObjectId(id)
      , identifier: 'identifier-' + id
      , eventType: 'Temp Basal'
      , absolute: 0
      , rate: 0
      , date
      , created_at: new Date(date).toISOString()
      , duration
      , durationInMilliseconds: duration * MIN
    };
  }

  // Same steps as dataloader.loadTreatments on a subsequent (15 minute window) load
  function loadTreatments () {
    const recent = mongoDocs.filter(d => d.date >= Date.now() - 15 * MIN);
    const r = ctx.ddata.processRawDataForRuntime(recent);
    return ctx.ddata.idMergePreferNew([], ctx.cache.insertData('treatments', r));
  }

  beforeEach(function () {
    ctx = { bus: new EventEmitter() };
    ctx.ddata = require('../lib/data/ddata')();
    ctx.cache = require('../lib/server/cache')({ extendedSettings: {} }, ctx);

    mongoDocs = [];
    const findDoc = identifier => mongoDocs.filter(d => d.identifier === identifier).map(d => ({ ...d }));
    const baseStorage = {
      findOne: async (identifier) => findDoc(identifier)
      , insertOne: async (doc) => { doc._id = doc._id || new ObjectId(); mongoDocs.push({ ...doc }); return doc.identifier; }
      , updateOne: async (identifier, setFields) => {
        mongoDocs = mongoDocs.map(d => d.identifier === identifier ? { ...d, ...setFields } : d);
        return 1;
      }
      , replaceOne: async (identifier, doc) => {
        mongoDocs = mongoDocs.map(d => d.identifier === identifier ? { ...doc, _id: d._id } : d);
        return 1;
      }
    };
    storage = new MongoCachedCollection(ctx, {}, 'treatments', baseStorage);
  });

  it('emits cache changes with runtime fields', async function () {
    const doc = rawTempBasal(5, 30, '0000000000000000000000a1');
    await storage.insertOne({ ...doc });

    const changes = ctx.cache.getData('treatments');
    changes.length.should.equal(1);
    changes[0].mills.should.equal(doc.date);
    changes[0].endmills.should.equal(doc.date + 30 * MIN);
    changes[0]._id.should.equal(doc._id.toString());
  });

  it('keeps mills on a temp basal patched more than 15 minutes after creation', async function () {
    const longTemp = rawTempBasal(40, 60, '0000000000000000000000a1');
    const nextTemp = rawTempBasal(5, 30, '0000000000000000000000b2');
    mongoDocs = [longTemp, nextTemp];

    // initial (2.5 day) load
    const initial = ctx.ddata.processRawDataForRuntime(mongoDocs);
    ctx.cache.insertData('treatments', initial);
    const lastData = { sgvs: [], treatments: JSON.parse(JSON.stringify(initial)) };

    // AAPS PATCHes the long temp with its real duration once the next one started
    await storage.updateOne(longTemp.identifier, { duration: 35, durationInMilliseconds: 35 * MIN });

    const treatments = loadTreatments();
    const patched = treatments.find(t => t.identifier === longTemp.identifier);
    patched.mills.should.equal(longTemp.date);
    patched.endmills.should.equal(longTemp.date + 35 * MIN);
    patched.duration.should.equal(35);

    const delta = calcDelta(lastData, { sgvs: [], treatments });
    delta.treatments.length.should.equal(1);
    delta.treatments[0].action.should.equal('update');
    delta.treatments[0].mills.should.equal(longTemp.date);
  });

  it('keeps mills on a temp basal replaced (PUT) more than 15 minutes after creation', async function () {
    const longTemp = rawTempBasal(40, 60, '0000000000000000000000a1');
    mongoDocs = [longTemp];
    ctx.cache.insertData('treatments', ctx.ddata.processRawDataForRuntime(mongoDocs));

    const replacement = { ...longTemp, duration: 20, durationInMilliseconds: 20 * MIN };
    delete replacement._id;
    await storage.replaceOne(longTemp.identifier, replacement);

    const patched = loadTreatments().find(t => t.identifier === longTemp.identifier);
    patched.mills.should.equal(longTemp.date);
    patched.duration.should.equal(20);
  });
});
