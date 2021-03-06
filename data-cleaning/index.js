const path = require('path')
const express = require('express');
const bodyParser = require('body-parser');
const db = require('./db');
const app = express();
const {PORT: port = 3001} = process.env

// TODO: prefix api routes. Update UI

app.use(bodyParser.json());
app.get('/status', (req, res) => res.send({ status: 'online' }));

app.get('/contributions/matches/:name/:addr1', async (req, res) => {
  const client = await db.getClient();
  try {
    const name = decodeURIComponent(req.params.name);
    const addr = decodeURIComponent(req.params.addr1);
    await client.query('select set_limit(0.7)');
    const records = await client.query(
      `select *
     ,similarity(name, $1) as name_sml
     ,similarity(street_line_1, $2) as addr1_sml
     from raw_contributions
     where name % $1
        and street_line_1 % $2`,
      [name, addr],
    );
    console.log(`Retrieved ${records.rowCount} rows`);
    res.send({ data: records.rows, count: records.rowCount });
  } catch (err) {
    handleError(res);
  } finally {
    client.release();
  }
});

app.get('/contributions/raw', async (req, res) => {
  let client = null;
  try {
    client = await db.getClient();
    const record = await client.query(`select name as search_name, street_line_1 as search_address
      from raw_contributions
      offset random() * (select count(*) from raw_contributions) limit 1
    `);
    const search = {
      name: record.rows[0].search_name,
      address: record.rows[0].search_address,
    };
    await client.query('select set_limit(0.7)');
    const records = await client.query(
      `select *
     ,similarity(name, $1) as name_sml
     ,similarity(street_line_1, $2) as addr1_sml
     from raw_contributions
     where name % $1
        and street_line_1 % $2
        and id not in (select source_contribution_id from contributions)
        `,
      [search.name, search.address],
    );
    res.send({ data: records.rows, count: records.rowCount, search });
  } catch (err) {
    handleError(res, err);
  } finally {
    client !== null && client.release();
  }
});

/**
 * Payload:
 * {
 *   data: ["uuid1", "uuid2"]
 * }
 */
app.post('/contributions/clean', async (req, res) => {
  let client = null;
  try {
    const { data: ids = [] } = req.body;
    if (ids.length === 0) {
      return handleError(res, 'unable to process request. data is empty');
    }
    const inStr = ids.map((_, idx) => `\$${idx + 1}`).join(', ');
    client = await db.getClient();
    const records = await client.query(
      `select * from raw_contributions where id in (${inStr})`,
      ids,
    );
    if (records.rows.length === 0) {
      return handleError(
        res,
        'unable to process record. No records found for the given ID',
      );
    }

    const contributor = await db.insertContributor(records.rows[0]);
    const contributorID = contributor.rows[0].id;
    const rawContributions = records.rows.map((x) => ({
      contributor_id: contributorID,
      source_contribution_id: x.id,
      ...x,
    }));
    const inserts = await db.insertContributions(rawContributions);
    if (inserts.rowCount === records.rowCount) {
      return res.send({ data: { status: 'success' } });
    } else {
      return handleError(
        res,
        new Error('unable to insert contributions' + JSON.stringify(inserts)),
      );
    }
  } catch (err) {
    return handleError(res, err);
  } finally {
    client !== null && client.release();
  }
});

if (process.env.NODE_ENV === 'production') {
  // Serve any static files
  app.use(express.static(path.join(__dirname, 'client/build')));
    
  // Handle React routing, return all requests to React app
  app.get('*', function(req, res) {
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
  });
}

/**
 *
 * @param {Response} res
 * @param {Error} err
 * @param {string} msg
 * @param {number} statusCode
 */
function handleError(
  res,
  err,
  msg = 'error processing request',
  statusCode = 500,
) {
  console.error(err);
  res.status(statusCode).send({ error: msg });
}

// GET CSV Export of matches

// After all the records are processed, probably split any remaining raw_contributions into the results

app.listen(port, () =>
  console.log(`app listening at http://localhost:${port}`),
);
