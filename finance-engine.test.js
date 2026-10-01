const test=require('node:test');
const assert=require('node:assert/strict');
require('./finance-engine.js');
const {apply,netWorth}=globalThis.FinanceEngine;
const balance=()=>({cash:10000,investments:3000,protected:2000,business:500,receivable:0,liabilities:0});
const tx=(kind,amount,category='')=>({kind,amount,category});

test('income increases cash by the exact amount',()=>{let b=balance();apply(b,tx('income',27000));assert.equal(b.cash,37000)});
test('expense decreases cash by the exact amount',()=>{let b=balance();apply(b,tx('expense',500));assert.equal(b.cash,9500)});
test('investment purchase moves value from cash to investments without changing net worth',()=>{let b=balance(),before=netWorth(b);apply(b,tx('investment',1000));assert.equal(b.cash,9000);assert.equal(b.investments,4000);assert.equal(netWorth(b),before)});
test('bucket allocation does not count as spending or reduce net worth',()=>{let b=balance(),before=netWorth(b);apply(b,tx('allocation',1000,'Business Fund'));assert.equal(b.business,1500);assert.equal(b.cash,10000);assert.equal(netWorth(b),before)});
test('savings to investment transfer changes asset mix without changing net worth',()=>{let b=balance(),before=netWorth(b);apply(b,{kind:'transfer',amount:1000,fromBucket:'savings',toBucket:'investment'});assert.equal(b.cash,9000);assert.equal(b.protected,1000);assert.equal(b.investments,4000);assert.equal(netWorth(b),before)});
test('savings to business transfer preserves cash and net worth',()=>{let b=balance(),before=netWorth(b);apply(b,{kind:'transfer',amount:1000,fromBucket:'savings',toBucket:'business'});assert.equal(b.cash,10000);assert.equal(b.protected,1000);assert.equal(b.business,1500);assert.equal(netWorth(b),before)});
test('loan given reduces cash and creates a receivable, not an expense',()=>{let b=balance(),before=netWorth(b);apply(b,tx('loan_given',2000));assert.equal(b.cash,8000);assert.equal(b.receivable,2000);assert.equal(netWorth(b),before)});
test('loan repayment received increases cash and reduces receivable',()=>{let b=balance();b.receivable=2000;apply(b,tx('loan_repayment_received',1000));assert.equal(b.cash,11000);assert.equal(b.receivable,1000)});
test('split expense records only the personal share as spending and the rest as receivable',()=>{let b=balance(),before=netWorth(b);apply(b,{kind:'split_expense',amount:2400,personalShare:600});assert.equal(b.cash,7600);assert.equal(b.receivable,1800);assert.equal(netWorth(b),before-600)});
test('refund increases cash and is represented separately for net expense reduction',()=>{let b=balance();apply(b,tx('refund',500));assert.equal(b.cash,10500)});
test('borrowing adds cash and a matching liability',()=>{let b=balance(),before=netWorth(b);apply(b,tx('loan_received',5000));assert.equal(b.cash,15000);assert.equal(b.liabilities,5000);assert.equal(netWorth(b),before)});
test('debt repayment decreases cash and liability by the same amount',()=>{let b=balance(),before=netWorth(b);b.liabilities=5000;before=netWorth(b);apply(b,tx('debt_repayment',1000));assert.equal(b.cash,9000);assert.equal(b.liabilities,4000);assert.equal(netWorth(b),before)});
