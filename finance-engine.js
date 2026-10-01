/* Deterministic balance engine. Bucket totals are allocations of cash, not extra assets. */
(function(root){
  function apply(balance,tx,direction=1){
    const d=direction*Math.abs(Number(tx.amount)||0);if(!d)throw new Error('Transaction amount must be greater than zero.');
    switch(tx.kind){
      case 'income':balance.cash+=d;break;
      case 'expense':case 'debt_repayment':balance.cash-=d;if(tx.kind==='debt_repayment')balance.liabilities-=d;break;
      case 'refund':balance.cash+=d;break;
      case 'investment':balance.cash-=d;balance.investments+=d;break;
      case 'allocation':if(tx.category==='Business Fund')balance.business+=d;else balance.protected+=d;break;
      case 'transfer':{
        const bucket=x=>/emergency|savings/.test((x||'').toLowerCase())?'protected':/business/.test((x||'').toLowerCase())?'business':/invest/.test((x||'').toLowerCase())?'investments':'spending';
        const from=bucket(tx.fromBucket),to=bucket(tx.toBucket);
        if(from==='investments'&&to!=='investments'){balance.investments-=d;balance.cash+=d}
        if(from!=='investments'&&to==='investments'){balance.cash-=d;balance.investments+=d}
        if(from==='protected')balance.protected-=d;if(from==='business')balance.business-=d;
        if(to==='protected')balance.protected+=d;if(to==='business')balance.business+=d;
        break;
      }
      case 'loan_given':balance.cash-=d;balance.receivable+=d;break;
      case 'loan_received':balance.cash+=d;balance.liabilities+=d;break;
      case 'loan_repayment_received':balance.cash+=d;balance.receivable-=d;break;
      case 'split_expense':{const mine=Math.min(d,Math.max(0,Number(tx.personalShare)||0));balance.cash-=d;balance.receivable+=d-mine;break}
      default:throw new Error('Unsupported transaction type: '+tx.kind);
    }return balance;
  }
  root.FinanceEngine={apply,netWorth:b=>b.cash+b.investments+b.receivable-b.liabilities,availableCash:b=>Math.max(0,b.cash-b.protected-b.business)};
})(typeof globalThis!=='undefined'?globalThis:this);
