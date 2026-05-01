// utils/batchDelete.js

async function deleteCollectionInBatchesIterative(
    db,
    collectionRef,
    batchSize = 500
  ) {
    let deletedCount = 0;
  
    while (true) {
      const snapshot = await collectionRef.limit(batchSize).get();
  
      if (snapshot.empty) {
        break;
      }
  
      const batch = db.batch();
  
      snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });
  
      await batch.commit();
      deletedCount += snapshot.size;
  
      console.log(
        `Deleted ${deletedCount} documents from subcollection...`
      );
    }
  }
  
  module.exports = { deleteCollectionInBatchesIterative };