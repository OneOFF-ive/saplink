import test from 'node:test';
import assert from 'node:assert/strict';
import { applySourceEdits, sourceUpdateSchema } from '../src/source-edit.js';
import { toolSchemas } from '../src/tool-definitions.js';

test('source edits use literal original fragments, preserve line endings and support multiple independent changes', () => {
  const original = "REPORT ztest.\r\nWRITE '原文'.\r\nWRITE 2.\r\n";
  assert.equal(applySourceEdits(original, [
    {old_text:'WRITE 2.',new_text:'WRITE 3.'},
    {old_text:"WRITE '原文'.",new_text:"WRITE '$& 中文'."}
  ]), "REPORT ztest.\r\nWRITE '$& 中文'.\r\nWRITE 3.\r\n");
  assert.equal(applySourceEdits('first;second;', [{old_text:'first;',new_text:''}]),'second;');
  assert.equal(applySourceEdits('one two', [{old_text:'one',new_text:'two'},{old_text:'two',new_text:'three'}]), 'two three');
});

test('missing, repeated and overlapping fragments reject the entire change instead of guessing', () => {
  assert.throws(()=>applySourceEdits('WRITE 1.',[{old_text:'WRITE 2.',new_text:'WRITE 3.'}]), /not found/);
  assert.throws(()=>applySourceEdits('aaaa',[{old_text:'aa',new_text:'b'}]), /more than once/);
  assert.throws(()=>applySourceEdits('abcdef',[{old_text:'abcd',new_text:'x'},{old_text:'cdef',new_text:'y'}]), /overlap/);
  assert.throws(()=>applySourceEdits('x',[{old_text:'x',new_text:'x'.repeat(1024*1024+1)}]), /exceeds/);
});

test('schemas require exactly one update mode and reject empty fragments or unbounded patch lists', () => {
  for(const input of [{},{source:'x',edits:[{old_text:'x',new_text:'y'}]},{edits:[]},
    {edits:[{old_text:'',new_text:'x'}]}, {edits:Array.from({length:51},()=>({old_text:'x',new_text:'y'}))}]) {
    assert.equal(sourceUpdateSchema.safeParse(input).success,false);
  }
  assert.equal(sourceUpdateSchema.safeParse({source:''}).success,true);
  const common={connection_id:'01234567-89ab-4def-8123-456789abcdef',object_uri:'/sap/bc/adt/programs/programs/ztest',expected_revision:'a'.repeat(64),request_id:'patch-test'};
  assert.equal(toolSchemas.update_source.safeParse({...common,edits:[{old_text:'x',new_text:'y'}],version:'inactive'}).success,true);
  assert.equal(toolSchemas.update_source.safeParse({...common,source:'x',edits:[{old_text:'x',new_text:'y'}]}).success,false);
});
