// parse signature from string to tree
var exports = module.exports = function(signature) {
 
   var index = 0;
   function next() {
      if (index < signature.length) {
          var c = signature[index];
          ++index;
          return c;
      }
      return null;
   }

   function parseOne(c)
   {
      function checkNotEnd(c) {
          if (!c) throw new Error('Bad signature: unexpected end');
          return c;
      }
 
      var match = {
          '{' : '}',
          '(' : ')'
      };
 
      var ele;
      var res = { type: c, child: [] };
      switch(c) {
      case 'a': // array
          ele = next();
          checkNotEnd(ele);
          res.child.push(parseOne(ele));
          return res;
      case '{': // dict entry
      case '(': // struct
          while(((ele = next()) !== null) && (ele !== match[c]))
             res.child.push(parseOne(ele));
          checkNotEnd(ele);
          return res;
      }
      return res;
   }

   var ret = [];
   var c;
   while ((c = next()) !== null)
       ret.push(parseOne(c));
   return ret;
};

// command-line test
// console.log(JSON.stringify(module.exports(process.argv[2]), null, 4));
