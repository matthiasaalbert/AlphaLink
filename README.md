AlphaLink/
├── package.json
├── .env.example
├── README.md
├── scripts/
│   ├── subscriptionBilling.js
│   ├── aggregatorMonitor.js    
│   └── riskScanner.js       
├── src/
│   ├── bot/
│   │   ├── bot.js             
│   │   ├── i18n.js        
│   │   └── commands/
│   │       ├── userCommands.js   
│   │       └── adminCommands.js  
│   ├── aggregator/
│   │   ├── aggregator.js         
│   │   ├── aggregatorStats.js   
│   │   └── aggregatorCache.js
│   ├── ai/
│   │   └── smart_trading_ai.js
│   ├── risk/
│   │   ├── risk_control.js 
│   │   └── meltdownMode.js
│   ├── vault/
│   │   ├── vaultProvider.js 
│   │   ├── vaultAESProvider.js 
│   │   ├── depositDetection.js 
│   │   ├── withdrawFlow.js   
│   │   ├── subscription.js     
│   │   └── vaultUtils.js      
│   ├── portfolio/
│   │   ├── copy_trading.js 
│   │   ├── portfolio_manager.js
│   │   └── followTrader.js   
│   ├── admin/
│   │   ├── admin.js        
│   │   ├── adminLogs.js       
│   │   ├── adminWebApp.js     
│   │   └── complianceTools.js
│   ├── database/
│   │   ├── database.js
│   │   └── migrations/  
│   └── utils/
│       ├── notifications.js  
│       ├── logs.js        
│       └── helpers.js          
└── index.js      
