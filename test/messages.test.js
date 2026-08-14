import test from 'node:test';
import assert from 'node:assert/strict';
import { docxXmlToText } from '../src/messages.js';

test('extracts readable text and layout from WordprocessingML', () => {
  const xml = [
    '<?xml version="1.0"?>',
    '<w:document xmlns:w="word"><w:body>',
    '<w:p><w:r><w:t>合同&amp;补充协议</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>第一条</w:t><w:tab/><w:t>期限&lt;三年&gt;</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>换行</w:t><w:br/><w:t>内容&#x4E2D;</w:t></w:r></w:p>',
    '</w:body></w:document>',
  ].join('');

  assert.equal(docxXmlToText(xml), '合同&补充协议\n第一条\t期限<三年>\n换行\n内容中');
});
