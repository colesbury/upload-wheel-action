/* 
 * Based on upload-s3-action by Dong Keon Kim 
 * https://github.com/shallwefootball/upload-s3-action
 */
import * as core from '@actions/core';
import { S3 } from "@aws-sdk/client-s3";
import { CloudFront } from "@aws-sdk/client-cloudfront";
import fs from 'fs';
import path from 'path';
import klawSync from 'klaw-sync';
import { lookup } from 'mime-types';

const AWS_KEY_ID = core.getInput('aws_key_id', {
  required: true
});
const SECRET_ACCESS_KEY = core.getInput('aws_secret_access_key', {
  required: true
});
const BUCKET = core.getInput('aws_bucket', {
  required: true
});
const AWS_REGION = core.getInput('aws_region', {
  required: false
});
const SOURCE_DIR = core.getInput('source_dir', {
  required: true
});
const DESTINATION_DIR = core.getInput('destination_dir', {
  required: false
});
const PACKAGE = core.getInput('package', {
  required: true
});
const DISTRIBUTION_ID = core.getInput('aws_distribution_id', {
  required: false
});

const s3 = new S3({
  region: AWS_REGION,
  credentials: {
    secretAccessKey: SECRET_ACCESS_KEY,
    accessKeyId: AWS_KEY_ID,
  },
});

const cloudfront = new CloudFront({
  region: AWS_REGION,
  credentials: {
    secretAccessKey: SECRET_ACCESS_KEY,
    accessKeyId: AWS_KEY_ID,
  },
});

const destinationDir = DESTINATION_DIR;
const paths = klawSync(SOURCE_DIR, {
  nodir: true
});

const modified_keys = []

async function upload_wheels() {
  core.info("uploading wheels");
  const sourceDir = path.join(process.cwd(), SOURCE_DIR);

  return Promise.all(paths.map(async (p) => {
    const fileStream = fs.createReadStream(p.path);
    const bucketPath = path.join(destinationDir, path.relative(sourceDir, p.path));
    const data = await s3.putObject({
      Bucket: BUCKET,
      Body: fileStream,
      Key: bucketPath,
      ContentType: lookup(p.path) || 'text/plain',
    });
    modified_keys.push(`/${bucketPath}`);
    return bucketPath;
  }));
}

function make_url(key) {
  return `    <a href="/${key}">${key}</a>`;
}

async function upload_index() {
  core.info("uploading index.html");
  const path = `${PACKAGE.toLowerCase()}/index.html`;
  const resp = await s3.listObjects({
    Bucket: BUCKET,
    Prefix: PACKAGE,
    Delimiter: "/",
  });
  
  const keys = [];
  for (const obj of resp.Contents) {
    keys.push(obj.Key);
  }

  var html = `
<!DOCTYPE html>
<html lang="en">
  <body>
${keys.map(make_url).join('\n')}
  </body>
</html>`;

  const prev_exists = await s3.headObject({
    Bucket: BUCKET,
    Key: path,
  }).then(_ => {
    return true;
  }).catch(error => {
    if (error.name === 'NotFound') {
      return false;
    }
    throw error;
  });


  await s3.putObject({
    Bucket: BUCKET,
    Body: html,
    Key: path,
    ContentType: 'text/html',
  });

  modified_keys.push(`/${path.replace('index.html', '')}`);

  if (!prev_exists) {
    await upload_top_index();
  }
}

async function upload_top_index() {
  core.info("uploading top-level index.html");
  const prefixes = await s3.listObjects({
    Bucket: BUCKET,
    Delimiter: "/",
  });

  const keys = [];
  for (const prefix of prefixes.CommonPrefixes) {
    const key = prefix.Prefix;
    if (key.startsWith(".")) {
      continue;
    }
    keys.push(key.substring(0, key.length - 1));
  }

  var html = `
<!DOCTYPE html>
<html lang="en">
  <body>
${keys.map(make_url).join('\n')}
  </body>
</html>`;

  await s3.putObject({
    Bucket: BUCKET,
    Body: html,
    Key: "index.html",
    ContentType: 'text/html',
  });

  modified_keys.push("/");
}

async function invalidate_paths() {
  if (!DISTRIBUTION_ID) {
    console.log("no cloudfront distribution to invalidate");
    return;
  }
  for (const path of modified_keys) {
    console.log(`invalidating: ${path}`);
  }
  await cloudfront.createInvalidation({
    DistributionId: DISTRIBUTION_ID,
    InvalidationBatch: {
      Paths: {
        Quantity: modified_keys.length,
        Items: modified_keys,
      },
      CallerReference: Date.now().toString(),
    }
  });
}

try {
  const locations = await upload_wheels();
  await upload_index();
  await invalidate_paths()

  core.info(`object key - ${destinationDir}`);
  core.info(`object locations - ${locations}`);
  core.setOutput('object_key', destinationDir);
  core.setOutput('object_locations', locations);  
}
catch (err) {
  core.error(err);
  core.setFailed(err.message);
}
